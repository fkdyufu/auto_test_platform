import type { DeviceResource } from "./catalog-store.js";

function normalizedType(value: string): string {
  return value.trim().toLowerCase();
}

export function deviceMatchesRoleType(
  device: Pick<DeviceResource, "types">,
  requiredType: string,
): boolean {
  const expected = normalizedType(requiredType);
  return Boolean(expected) && device.types.some((type) => normalizedType(type) === expected);
}
