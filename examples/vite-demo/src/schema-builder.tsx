import { useEffect, useRef } from "react";
import { useFieldArray, useForm } from "react-hook-form";

type SchemaFieldDraft = {
  name: string;
  type: string;
};

type SchemaBuilderForm = {
  fields: SchemaFieldDraft[];
};

const TYPE_OPTIONS = [
  "address",
  "bool",
  "bytes",
  "bytes32",
  "int8",
  "int16",
  "int32",
  "int64",
  "int256",
  "string",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uint128",
  "uint256"
] as const;

const FIELD_TEMPLATES: readonly SchemaFieldDraft[] = [
  {
    name: "recipient",
    type: "address"
  },
  {
    name: "valueHash",
    type: "bytes32"
  },
  {
    name: "contentType",
    type: "string"
  },
  {
    name: "version",
    type: "uint64"
  }
];

function createBlankField(): SchemaFieldDraft {
  return {
    name: "",
    type: "string"
  };
}

function parseSchemaDefinition(schema: string): SchemaFieldDraft[] {
  const segments = schema
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean);

  const fields = segments
    .map((segment) => {
      const match = segment.match(/^(.+?)\s+([A-Za-z_][A-Za-z0-9_]*)$/);

      if (!match) {
        return null;
      }

      return {
        type: match[1]?.trim() ?? "",
        name: match[2]?.trim() ?? ""
      };
    })
    .filter((field): field is SchemaFieldDraft => field !== null);

  return fields.length > 0 ? fields : [createBlankField()];
}

function serializeSchemaDefinition(fields: SchemaFieldDraft[]): string {
  return fields
    .map((field) => {
      const type = field.type.trim();
      const name = field.name.trim();

      if (!type || !name) {
        return "";
      }

      return `${type} ${name}`;
    })
    .filter(Boolean)
    .join(",");
}

type SchemaFieldRowProps = {
  index: number;
  disabled: boolean;
  onRemove: (index: number) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  registerName: ReturnType<typeof useForm<SchemaBuilderForm>>["register"];
};

function SchemaFieldRow({
  index,
  disabled,
  onRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  registerName
}: SchemaFieldRowProps) {
  return (
    <div className="schema-row">
      <div className="schema-index-pill">{String(index + 1).padStart(2, "0")}</div>
      <label className="schema-field-stack">
        <span>Name</span>
        <input
          {...registerName(`fields.${index}.name`)}
          className="schema-input"
          placeholder="fieldName"
          disabled={disabled}
        />
      </label>
      <label className="schema-field-stack">
        <span>Type</span>
        <select
          {...registerName(`fields.${index}.type`)}
          className="schema-input"
          disabled={disabled}
        >
          {TYPE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <div className="schema-row-actions">
        <button
          type="button"
          className="schema-inline-button"
          disabled={disabled || !canMoveUp}
          onClick={() => onMoveUp(index)}
        >
          Up
        </button>
        <button
          type="button"
          className="schema-inline-button"
          disabled={disabled || !canMoveDown}
          onClick={() => onMoveDown(index)}
        >
          Down
        </button>
        <button
          type="button"
          className="schema-remove-button"
          disabled={disabled}
          onClick={() => onRemove(index)}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

export function SchemaBuilder(props: {
  value: string;
  disabled?: boolean;
  onChange: (nextValue: string) => void;
}) {
  const { value, disabled = false, onChange } = props;
  const lastValueRef = useRef(value.trim());
  const form = useForm<SchemaBuilderForm>({
    defaultValues: {
      fields: parseSchemaDefinition(value)
    }
  });
  const { control, register, reset, watch } = form;
  const { fields, append, remove, move, replace } = useFieldArray({
    control,
    name: "fields"
  });

  const watchedFields = watch("fields");
  const serialized = serializeSchemaDefinition(watchedFields ?? []);

  useEffect(() => {
    const normalized = serialized.trim();

    if (normalized === lastValueRef.current) {
      return;
    }

    lastValueRef.current = normalized;
    onChange(normalized);
  }, [onChange, serialized]);

  useEffect(() => {
    const normalized = value.trim();

    if (normalized === lastValueRef.current) {
      return;
    }

    lastValueRef.current = normalized;
    reset({
      fields: parseSchemaDefinition(value)
    });
  }, [reset, value]);

  return (
    <div className="schema-builder" data-testid="schema-builder">
      <div className="schema-builder-toolbar">
        <div className="schema-builder-copy">
          <p className="panel-note">Envelope Fields</p>
          <h4>Compact schema editor</h4>
          <p>
            Add ordered fields for the published EAS schema. Keep the envelope small,
            then use records to store richer JSON payloads.
          </p>
        </div>
        <div className="schema-builder-actions">
          <button
            type="button"
            className="subtle-button"
            disabled={disabled}
            onClick={() => append(createBlankField())}
          >
            Add Field
          </button>
          <button
            type="button"
            className="subtle-button"
            disabled={disabled}
            onClick={() => replace(parseSchemaDefinition(DEFAULT_SCHEMA_STRING))}
          >
            Restore Default
          </button>
        </div>
      </div>

      <div className="schema-template-chips">
        {FIELD_TEMPLATES.map((template) => (
          <button
            key={`${template.type}:${template.name}`}
            type="button"
            className="schema-template-chip"
            disabled={disabled}
            onClick={() => append(template)}
          >
            + {template.name}
          </button>
        ))}
      </div>

      <div className="schema-field-list">
        {fields.map((field, index) => (
          <SchemaFieldRow
            key={field.id}
            index={index}
            disabled={disabled}
            onRemove={remove}
            onMoveUp={(currentIndex) => move(currentIndex, currentIndex - 1)}
            onMoveDown={(currentIndex) => move(currentIndex, currentIndex + 1)}
            canMoveUp={index > 0}
            canMoveDown={index < fields.length - 1}
            registerName={register}
          />
        ))}
      </div>

      <div className="schema-output">
        <span className="panel-note">Generated EAS Schema</span>
        <pre data-testid="schema-definition-output">
          {serialized || "Add at least one named field to generate a schema."}
        </pre>
      </div>
    </div>
  );
}

const DEFAULT_SCHEMA_STRING =
  "bytes32 namespace,bytes32 key,bytes32 valueHash,string valueURI,string contentType,uint64 version,uint8 operation,bytes32 previousUID,bytes extra";
