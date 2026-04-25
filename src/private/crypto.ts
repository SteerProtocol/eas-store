import { canonicalizeJson } from "../codecs/canonical-json";
import { ConfigurationError, VerificationError } from "../errors";
import type { Address, Hex } from "../types";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToUtf8,
  canonicalBytes,
  digestBytes,
  digestJson,
  randomBytes,
  utf8ToBytes
} from "./encoding";
import type {
  EncryptionIdentity,
  PrivateCryptoContext,
  PrivateCryptoProvider,
  PrivateEnvelope,
  PrivateReader,
  WrappedDataKey
} from "./types";
import type { WebCryptoJwk, WebCryptoKey, WebCryptoSubtle } from "./webcrypto-types";

function subtle(): WebCryptoSubtle {
  if (!globalThis.crypto?.subtle) {
    throw new ConfigurationError("Private records require WebCrypto crypto.subtle.");
  }

  return globalThis.crypto.subtle;
}

function normalizeAddress(address: string): Address {
  return address.toLowerCase() as Address;
}

function normalizePublicKey(publicKey: WebCryptoJwk): WebCryptoJwk {
  return {
    key_ops: [],
    ext: true,
    kty: publicKey.kty,
    x: publicKey.x,
    y: publicKey.y,
    crv: publicKey.crv
  };
}

export function computeEncryptionKeyId(input: {
  algorithm: string;
  dappId: string;
  publicKey: WebCryptoJwk;
  wallet: Address;
}): Hex {
  return digestJson({
    algorithm: input.algorithm,
    dappId: input.dappId,
    publicKey: normalizePublicKey(input.publicKey),
    wallet: normalizeAddress(input.wallet)
  });
}

export function publicKeyFromPrivateJwk(privateKey: WebCryptoJwk): WebCryptoJwk {
  if (
    privateKey.kty !== "EC" ||
    privateKey.crv !== "P-256" ||
    typeof privateKey.x !== "string" ||
    typeof privateKey.y !== "string"
  ) {
    throw new VerificationError("Restored private key is not a supported ECDH P-256 key.");
  }

  return normalizePublicKey(privateKey);
}

async function importReaderPublicKey(reader: PrivateReader): Promise<WebCryptoKey> {
  return subtle().importKey(
    "jwk",
    normalizePublicKey(reader.publicKey),
    {
      name: "ECDH",
      namedCurve: "P-256"
    },
    false,
    []
  );
}

async function deriveWrapKey(
  privateKey: WebCryptoKey,
  publicKey: WebCryptoKey,
  info: Uint8Array
): Promise<WebCryptoKey> {
  const sharedSecret = await subtle().deriveBits(
    {
      name: "ECDH",
      public: publicKey
    },
    privateKey,
    256
  );
  const hkdfKey = await subtle().importKey(
    "raw",
    sharedSecret,
    "HKDF",
    false,
    ["deriveKey"]
  );

  return subtle().deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8ToBytes("eas-store-private-v1"),
      info
    },
    hkdfKey,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );
}

function contextFor(input: PrivateCryptoContext): PrivateCryptoContext {
  return {
    namespace: input.namespace,
    key: input.key,
    dappId: input.dappId,
    schemaUID: input.schemaUID.toLowerCase() as Hex,
    recordVersion: input.recordVersion,
    writer: normalizeAddress(input.writer),
    keyId: input.keyId.toLowerCase() as Hex
  };
}

function aadFor(input: PrivateCryptoContext & { alg: string }): Uint8Array {
  const context = contextFor(input);
  return utf8ToBytes(
    canonicalizeJson({
      alg: input.alg,
      dappId: context.dappId,
      key: context.key,
      keyHash: digestBytes(utf8ToBytes(context.key)),
      keyId: context.keyId,
      namespace: context.namespace,
      namespaceHash: digestBytes(utf8ToBytes(context.namespace)),
      recordVersion: context.recordVersion,
      schemaUID: context.schemaUID,
      version: 1
    })
  );
}

function wrapAadFor(input: {
  context: PrivateCryptoContext;
  reader: Address;
  readerKeyId: Hex;
  algorithm: string;
}): Uint8Array {
  const context = contextFor(input.context);
  return utf8ToBytes(
    canonicalizeJson({
      algorithm: input.algorithm,
      contextHash: digestJson(context),
      keyId: context.keyId,
      reader: normalizeAddress(input.reader),
      readerKeyId: input.readerKeyId.toLowerCase(),
      version: 1
    })
  );
}

export function computeWrappedKeysHash(wrappedKeys: WrappedDataKey[]): Hex {
  return digestJson(
    wrappedKeys
      .map((wrapped) => ({
        algorithm: wrapped.algorithm,
        encryptedKey: wrapped.encryptedKey,
        iv: wrapped.iv,
        reader: wrapped.reader.toLowerCase(),
        readerKeyId: wrapped.readerKeyId.toLowerCase()
      }))
      .sort((a, b) => `${a.reader}:${a.readerKeyId}`.localeCompare(`${b.reader}:${b.readerKeyId}`))
  );
}

export class WebCryptoPrivateCryptoProvider implements PrivateCryptoProvider {
  async createIdentity(input: {
    wallet: Address;
    dappId: string;
  }): Promise<EncryptionIdentity> {
    const keyPair = await subtle().generateKey(
      {
        name: "ECDH",
        namedCurve: "P-256"
      },
      true,
      ["deriveKey", "deriveBits"]
    );
    const publicKey = normalizePublicKey((await subtle().exportKey(
      "jwk",
      keyPair.publicKey
    )) as unknown as WebCryptoJwk);
    const keyId = computeEncryptionKeyId({
      algorithm: "ECDH-P256+A256GCM",
      dappId: input.dappId,
      publicKey,
      wallet: normalizeAddress(input.wallet)
    });

    return {
      wallet: normalizeAddress(input.wallet),
      dappId: input.dappId,
      keyId,
      algorithm: "ECDH-P256+A256GCM",
      publicKey,
      privateKey: keyPair.privateKey,
      keyVersion: 1,
      createdAt: Math.floor(Date.now() / 1000)
    };
  }

  async encryptValue(input: {
    value: unknown;
    key: string;
    namespace: string;
    dappId: string;
    schemaUID: Hex;
    recordVersion: number;
    writer: EncryptionIdentity;
    readers: PrivateReader[];
  }): Promise<PrivateEnvelope> {
    const dataKey = await subtle().generateKey(
      {
        name: "AES-GCM",
        length: 256
      },
      true,
      ["encrypt", "decrypt"]
    );
    const iv = randomBytes(12);
    const context = contextFor({
      namespace: input.namespace,
      key: input.key,
      dappId: input.dappId,
      schemaUID: input.schemaUID,
      recordVersion: input.recordVersion,
      writer: input.writer.wallet,
      keyId: input.writer.keyId
    });
    const aad = aadFor({
      ...context,
      alg: "AES-256-GCM"
    });
    const ciphertext = await subtle().encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: aad
      },
      dataKey,
      canonicalBytes(input.value)
    );
    const readers = new Map<string, PrivateReader>();

    readers.set(input.writer.wallet, {
      wallet: input.writer.wallet,
      keyId: input.writer.keyId,
      algorithm: input.writer.algorithm,
      publicKey: input.writer.publicKey,
      keyVersion: input.writer.keyVersion,
      dappId: input.writer.dappId,
      createdAt: input.writer.createdAt,
      ...(input.writer.expiresAt ? { expiresAt: input.writer.expiresAt } : {})
    });

    for (const reader of input.readers) {
      readers.set(reader.wallet, reader);
    }

    const wrappedKeys = await Promise.all(
      Array.from(readers.values()).map((reader) =>
        this.wrapDataKey({
          dataKey,
          reader,
          context
        })
      )
    );

    return {
      version: 1,
      alg: "AES-256-GCM",
      keyId: input.writer.keyId,
      owner: normalizeAddress(input.writer.wallet),
      dappId: input.dappId,
      schemaUID: input.schemaUID.toLowerCase() as Hex,
      namespaceHash: digestBytes(utf8ToBytes(input.namespace)),
      keyHash: digestBytes(utf8ToBytes(input.key)),
      recordVersion: input.recordVersion,
      iv: bytesToBase64Url(iv),
      ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
      aadHash: digestJson(JSON.parse(bytesToUtf8(aad))),
      wrappedKeysHash: computeWrappedKeysHash(wrappedKeys),
      wrappedKeys
    };
  }

  async decryptValue<T = unknown>(input: {
    envelope: PrivateEnvelope;
    key: string;
    namespace: string;
    dappId: string;
    schemaUID: Hex;
    identity: EncryptionIdentity;
  }): Promise<T> {
    if (input.envelope.dappId !== input.dappId) {
      throw new VerificationError("Private envelope dapp ID does not match.");
    }
    if (input.envelope.schemaUID.toLowerCase() !== input.schemaUID.toLowerCase()) {
      throw new VerificationError("Private envelope schema UID does not match.");
    }
    if (input.envelope.namespaceHash.toLowerCase() !== digestBytes(utf8ToBytes(input.namespace)).toLowerCase()) {
      throw new VerificationError("Private envelope namespace hash does not match.");
    }
    if (input.envelope.keyHash.toLowerCase() !== digestBytes(utf8ToBytes(input.key)).toLowerCase()) {
      throw new VerificationError("Private envelope key hash does not match.");
    }
    if (input.envelope.wrappedKeysHash.toLowerCase() !== computeWrappedKeysHash(input.envelope.wrappedKeys).toLowerCase()) {
      throw new VerificationError("Private envelope wrapped key list does not match.");
    }

    const wrappedKey = input.envelope.wrappedKeys.find(
      (candidate) =>
        candidate.reader.toLowerCase() === input.identity.wallet.toLowerCase() &&
        candidate.readerKeyId.toLowerCase() === input.identity.keyId.toLowerCase()
    );

    if (!wrappedKey) {
      throw new VerificationError("No wrapped data key is available for this identity.");
    }

    const context = contextFor({
      namespace: input.namespace,
      key: input.key,
      dappId: input.dappId,
      schemaUID: input.schemaUID,
      recordVersion: input.envelope.recordVersion,
      writer: input.envelope.owner,
      keyId: input.envelope.keyId
    });
    const dataKey = await this.unwrapDataKey({
      wrappedKey,
      identity: input.identity,
      context
    });
    const aad = aadFor({
      ...context,
      alg: input.envelope.alg
    });
    const aadHash = digestJson(JSON.parse(bytesToUtf8(aad)));

    if (aadHash.toLowerCase() !== input.envelope.aadHash.toLowerCase()) {
      throw new VerificationError("Private envelope authenticated data does not match.");
    }

    const plaintext = await subtle().decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(input.envelope.iv),
        additionalData: aad
      },
      dataKey,
      base64UrlToBytes(input.envelope.ciphertext)
    );

    return JSON.parse(bytesToUtf8(new Uint8Array(plaintext))) as T;
  }

  async wrapDataKey(input: {
    dataKey: WebCryptoKey;
    reader: PrivateReader;
    context: PrivateCryptoContext;
  }): Promise<WrappedDataKey> {
    const publicKey = await importReaderPublicKey(input.reader);
    const ephemeral = await subtle().generateKey(
      {
        name: "ECDH",
        namedCurve: "P-256"
      },
      true,
      ["deriveBits"]
    );
    const wrapAad = wrapAadFor({
      context: input.context,
      reader: input.reader.wallet,
      readerKeyId: input.reader.keyId,
      algorithm: "ECDH-P256+A256GCM"
    });
    const wrapKey = await deriveWrapKey(ephemeral.privateKey, publicKey, wrapAad);
    const rawDataKey = await subtle().exportKey("raw", input.dataKey);
    const iv = randomBytes(12);
    const encrypted = await subtle().encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: wrapAad
      },
      wrapKey,
      rawDataKey
    );
    const ephemeralPublicKey = await subtle().exportKey("jwk", ephemeral.publicKey);

    return {
      reader: normalizeAddress(input.reader.wallet),
      readerKeyId: input.reader.keyId,
      algorithm: "ECDH-P256+A256GCM",
      iv: bytesToBase64Url(iv),
      encryptedKey: bytesToBase64Url(
        canonicalBytes({
          ephemeralPublicKey,
          key: bytesToBase64Url(new Uint8Array(encrypted))
        })
      )
    };
  }

  async unwrapDataKey(input: {
    wrappedKey: WrappedDataKey;
    identity: EncryptionIdentity;
    context: PrivateCryptoContext;
  }): Promise<WebCryptoKey> {
    if (input.wrappedKey.algorithm !== "ECDH-P256+A256GCM") {
      throw new VerificationError(`Unsupported wrapped key algorithm: ${input.wrappedKey.algorithm}`);
    }

    const parsed = JSON.parse(bytesToUtf8(base64UrlToBytes(input.wrappedKey.encryptedKey))) as {
      ephemeralPublicKey: WebCryptoJwk;
      key: string;
    };
    const ephemeralPublicKey = await subtle().importKey(
      "jwk",
      parsed.ephemeralPublicKey,
      {
        name: "ECDH",
        namedCurve: "P-256"
      },
      false,
      []
    );
    const wrapAad = wrapAadFor({
      context: input.context,
      reader: input.wrappedKey.reader,
      readerKeyId: input.wrappedKey.readerKeyId,
      algorithm: input.wrappedKey.algorithm
    });
    const wrapKey = await deriveWrapKey(input.identity.privateKey, ephemeralPublicKey, wrapAad);
    const rawDataKey = await subtle().decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(input.wrappedKey.iv),
        additionalData: wrapAad
      },
      wrapKey,
      base64UrlToBytes(parsed.key)
    );

    return subtle().importKey(
      "raw",
      rawDataKey,
      {
        name: "AES-GCM",
        length: 256
      },
      true,
      ["encrypt", "decrypt"]
    );
  }
}
