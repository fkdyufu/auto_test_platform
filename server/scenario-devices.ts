import { CatalogError, type DeviceResource, type ScenarioRun, type TestScenario } from "./catalog-store.js";

export function resolveScenarioDevices(
  scenario: TestScenario,
  scenarioRun: ScenarioRun,
  availableDevices: DeviceResource[],
): DeviceResource[] {
  if (!scenario.isDefault && !scenario.roles.length) throw new CatalogError("测试场景至少需要一个设备角色");
  const devices: DeviceResource[] = [];
  const roleKeys = new Set<string>();
  const deviceIds = new Set<string>();
  for (const role of scenario.roles) {
    const deviceId = scenarioRun.roleBindings[role.key];
    if (!deviceId || deviceId !== role.deviceId) throw new CatalogError(`角色“${role.key}”未绑定设备或绑定与执行快照不一致`);
    if (roleKeys.has(role.key.toLowerCase())) throw new CatalogError("角色标识不能重复");
    if (deviceIds.has(deviceId)) throw new CatalogError("同一场景不能重复绑定设备");
    const device = availableDevices.find((item) => item.id === deviceId && item.productId === scenario.productId && !item.archivedAt);
    if (!device) throw new CatalogError(`角色“${role.key}”绑定的设备不存在或不属于当前产品`);
    roleKeys.add(role.key.toLowerCase());
    deviceIds.add(deviceId);
    devices.push(device);
  }
  return devices;
}
