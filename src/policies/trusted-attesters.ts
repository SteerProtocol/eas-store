import type { Address } from "../types";

export function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function isTrustedAttester(
  attester: string,
  trustedAttesters?: Address[]
): boolean {
  if (!trustedAttesters || trustedAttesters.length === 0) {
    return true;
  }

  return trustedAttesters.some((candidate) => sameAddress(candidate, attester));
}
