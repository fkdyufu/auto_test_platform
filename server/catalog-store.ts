import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssetChange, AssetDifference, AssetKind, AssetPreview, LabChange, LabOperation, LabPreview } from "../shared/assistant.js";
import { applyLabOperations, diffPhysicalLab } from "./lab-changes.js";
import type { CaseRecovery, TestResultDetails } from "../shared/test-result.js";
import { parseStepRows, stepRowsFromLegacy, stepRowsToText, type TestCaseStep } from "../shared/test-case-steps.js";
import {
  DEFAULT_PLATFORM_NAME,
  LAB_PORT_KINDS,
  LAB_PORT_KIND_LABELS,
  PLATFORM_NODE_ID,
  portKindsCompatible,
  withLinkRoles,
  type LabCable,
  type LabLinkEnd,
  type LabNode,
  type LabPort,
  type LabPortKind,
  type PhysicalLab,
} from "../shared/physical-lab.js";

import {
  CONTROL_KINDS,
  controlFromLegacy,
  isControlKind,
  isFieldShown,
  missingControlFields,
  secretKeys,
  type ControlInterface,
  type ControlKind,
  type LegacyControlInterface,
  type PublicControlInterface,
} from "../shared/control-interfaces.js";
import { deviceTemplateName, isDeviceTemplateId, templateFromLegacyTypes, type DeviceTemplateId } from "../shared/device-templates.js";
import { parseDevicePorts, withDevicePortIds, type DevicePort } from "../shared/device-ports.js";
import { analyzeScenarioTopology, ipv4ToNumber, isVlanId, parseSubnet, topologyProblems, type ScenarioSegment } from "../shared/scenario-topology.js";

export type { PhysicalLab } from "../shared/physical-lab.js";
export type { ControlInterface, ControlKind, PublicControlInterface } from "../shared/control-interfaces.js";
export type { DeviceTemplateId } from "../shared/device-templates.js";

export type ExecutionStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type TestOutcome = "passed" | "failed";

export interface Product {
  id: string;
  name: string;
  description: string;
  zentaoId: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface TestCase {
  id: string;
  productId: string;
  scenarioId: string;
  source: "local" | "zentao";
  zentaoCaseId?: number;
  lastImportedAt?: string;
  name: string;
  precondition: string;
  steps: string;
  expectedResult: string;
  stepRows: TestCaseStep[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface DeviceResource {
  id: string;
  productId: string;
  name: string;
  /** The type card picked when the device was added. */
  template: DeviceTemplateId;
  description: string;
  ports?: DevicePort[];
  controlInterfaces: ControlInterface[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

interface LegacyPhysicalConnection {
  id: string;
  sourceDeviceId: string;
  sourcePort: string;
  targetDeviceId: string;
  targetPort: string;
  description: string;
}

interface LegacyPhysicalEnvironment {
  id: string;
  productId: string;
  name: string;
  description: string;
  deviceIds: string[];
  connections: LegacyPhysicalConnection[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface ScenarioRole {
  id: string;
  key: string;
  deviceId: string;
}

export interface ScenarioParameter {
  id: string;
  key: string;
  name: string;
  defaultValue: string;
}

export interface TestScenario {
  id: string;
  productId: string;
  isDefault: boolean;
  name: string;
  category: string;
  description: string;
  roles: ScenarioRole[];
  /** The logical topology: which role interfaces share a layer-2 segment, their addresses and device ports. */
  segments: ScenarioSegment[];
  parameters: ScenarioParameter[];
  setupInstructions: string;
  verificationInstructions: string;
  cleanupInstructions: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface TestOrder {
  id: string;
  productId: string;
  name: string;
  description: string;
  caseIds: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

type LegacyTestOrder = TestOrder & {
  physicalEnvironmentId?: string;
  environmentId?: string;
  targetUrl?: string;
  username?: string;
  password?: string;
  scenarioId?: string;
  roleBindings?: Record<string, string>;
};

export interface CaseRun {
  id: string;
  testCaseId: string;
  scenarioRunId: string;
  caseNameSnapshot: string;
  preconditionSnapshot: string;
  stepsSnapshot: string;
  expectedResultSnapshot: string;
  stepRowsSnapshot?: TestCaseStep[];
  status: ExecutionStatus;
  outcome?: TestOutcome;
  summary?: string;
  resultDetails?: TestResultDetails;
  /** How the case's own changes were undone after its conclusion. */
  recovery?: CaseRecovery;
  startedAt?: string;
  finishedAt?: string;
}

export interface ScenarioRun {
  id: string;
  testScenarioId: string;
  scenarioNameSnapshot: string;
  isDefault: boolean;
  status: ExecutionStatus;
  outcome?: TestOutcome;
  roleBindings: Record<string, string>;
  scenarioSnapshot?: TestScenario;
  parameterValues: Record<string, string>;
  caseRunIds: string[];
  summary?: string;
  cleanupOutcome?: TestOutcome;
  cleanupSummary?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface TestRun {
  id: string;
  testOrderId: string;
  triggerType: "all" | "single";
  status: ExecutionStatus;
  outcome?: TestOutcome;
  scenarioRuns: ScenarioRun[];
  caseRuns: CaseRun[];
  /** Wiring as registered when the run was created, with device names resolved. */
  physicalLabSnapshot?: PhysicalLab;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** The lab as saved: platform and external nodes, and cables without their role. */
type StoredPhysicalLab = Omit<PhysicalLab, "links"> & { links: LabCable[] };

interface CatalogData {
  version: 17;
  products: Product[];
  testCases: TestCase[];
  deviceResources: DeviceResource[];
  /** One cabled lab per product. Device nodes reuse device IDs; names are resolved when read. */
  physicalLabs: StoredPhysicalLab[];
  testScenarios: TestScenario[];
  testOrders: TestOrder[];
  testRuns: TestRun[];
}

type LegacyTestCase = Omit<TestCase, "scenarioId" | "source" | "precondition" | "stepRows"> & {
  scenarioId?: string;
  source?: TestCase["source"];
  precondition?: string;
  stepRows?: TestCaseStep[];
};
type LegacyCaseRun = Omit<CaseRun, "scenarioRunId" | "preconditionSnapshot"> & {
  scenarioRunId?: string;
  preconditionSnapshot?: string;
};
type LegacyTestRun = Omit<TestRun, "scenarioRuns" | "caseRuns"> & {
  scenarioRuns?: ScenarioRun[];
  caseRuns: LegacyCaseRun[];
};
type LegacyDeviceResource = Omit<DeviceResource, "template" | "controlInterfaces"> & {
  template?: string;
  type?: string;
  types?: string[] | string;
  model?: string;
  controlInterfaces?: Array<Partial<ControlInterface> & Partial<LegacyControlInterface>>;
};

export interface ProductSummary extends Product {
  caseCount: number;
  orderCount: number;
}

export interface DeviceResourceSummary extends Omit<DeviceResource, "controlInterfaces"> {
  /** The type's display name; the product type shows the product's name. */
  templateName: string;
  controlInterfaces: PublicControlInterface[];
}

export interface TestOrderSummary extends TestOrder {
  productName: string;
  caseCount: number;
  latestRun?: TestRun;
}

export interface TestOrderDetail extends TestOrderSummary {
  cases: TestCase[];
  runs: TestRun[];
}

export interface TestOrderExecutionContext {
  productName?: string;
  devices: DeviceResource[];
  scenarios: TestScenario[];
  physicalLab?: PhysicalLab;
  /** Every device of the product, for tracing a scenario's segments through switches that are not roles. */
  labDevices?: DeviceResource[];
}

export interface TestRunReportContext {
  product: Pick<Product, "id" | "name">;
  testOrder: Pick<TestOrder, "id" | "name" | "description">;
  testRun: TestRun;
}

export interface DiagnosticExecutionContext extends TestOrderExecutionContext {
  product: Product;
  testOrder: TestOrder;
  testRun: TestRun;
  caseRun: CaseRun;
  scenarioRun: ScenarioRun;
  scenario?: TestScenario;
  physicalLabSource?: "snapshot" | "current";
}

export interface ImportedTestCaseInput {
  zentaoCaseId: number;
  name: string;
  precondition: string;
  steps: string;
  expectedResult: string;
  stepRows?: TestCaseStep[];
}

export interface TestCaseImportResult {
  created: number;
  updated: number;
  skipped: number;
}

export class CatalogError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

function requiredText(value: unknown, label: string, maxLength = 10_000): string {
  if (typeof value !== "string" || !value.trim()) throw new CatalogError(`${label}不能为空`);
  const text = value.trim();
  if (text.length > maxLength) throw new CatalogError(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function optionalText(value: unknown, maxLength = 10_000): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length > maxLength) throw new CatalogError(`字段不能超过 ${maxLength} 个字符`);
  return text;
}

/** Free-text type labels used before catalog version 14, e.g. "host / peer". */
function legacyDeviceTypes(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const types = values
    .flatMap((item) => typeof item === "string" ? item.split(/[/,，]/) : [])
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Map(types.map((item) => [item.toLowerCase(), item])).values()];
}

/**
 * Turns the old type labels and model into a type card plus description lines, so nothing typed before is lost:
 * the model and any labels that did not map to a card are kept in the description.
 */
function migrateDeviceIdentity(input: { types?: unknown; type?: unknown; model?: unknown; description?: unknown }, productName: string) {
  const types = legacyDeviceTypes(input.types ?? input.type);
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const template = templateFromLegacyTypes(types, model, productName);
  const notes = [
    model && !(template === "product" && model.toLowerCase() === productName.trim().toLowerCase()) ? `型号：${model}` : "",
    template === "custom" && types.length ? `原类型：${types.join("、")}` : "",
  ];
  const description = [typeof input.description === "string" ? input.description.trim() : "", ...notes].filter(Boolean).join("\n");
  return { template, description };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function uniqueName(data: { name: string; archivedAt?: string }[], name: string, label: string, currentId?: string): void {
  if (data.some((item) => !item.archivedAt && (item as { id?: string }).id !== currentId && item.name.toLowerCase() === name.toLowerCase())) {
    throw new CatalogError(`${label}已存在`, 409);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** A device as the lab shows it: its ports, and the port each control method goes through. */
function deviceLabNode(device: DeviceResource): LabNode {
  const ports = (device.ports || []).map(({ id, name, kind, note }) => ({ id, name, kind, note }));
  const portIds = new Set(ports.map((port) => port.id));
  const controlPorts = Object.fromEntries(device.controlInterfaces
    .filter((control) => control.portId && portIds.has(control.portId))
    .map((control) => [control.id, control.portId!]));
  return { id: device.id, kind: "device", name: device.name, ports, controlPorts };
}

type DevicePortEdits = Map<string, Pick<LabNode, "ports" | "controlPorts">>;

/** Devices with port edits made through the lab applied. A device is only replaced when something changed. */
function withDevicePortEdits(devices: DeviceResource[], edits: DevicePortEdits, timestamp: string): DeviceResource[] {
  return devices.map((device) => {
    const edit = edits.get(device.id);
    if (!edit) return device;
    const previous = (device.ports || []).map(({ id, name, kind, specification, note }) => ({ id, name, kind, specification, note }));
    const specifications = new Map(previous.map((port) => [port.id, port.specification]));
    const ports = edit.ports.map(({ id, name, kind, note }) => ({ id, name, kind, specification: specifications.get(id) || "", note }));
    const samePorts = JSON.stringify(ports) === JSON.stringify(previous);
    if (samePorts && device.controlInterfaces.every((control) => (control.portId || "") === (edit.controlPorts[control.id] || ""))) return device;
    return {
      ...device,
      ports,
      controlInterfaces: device.controlInterfaces.map(({ portId: _portId, ...control }) => edit.controlPorts[control.id] ? { ...control, portId: edit.controlPorts[control.id] } : control),
      updatedAt: timestamp,
    };
  });
}

/** Scenario interfaces let go of ports their devices no longer have, so a removed port never blocks saving a scenario. */
function dropRemovedScenarioPorts(data: CatalogData): void {
  const portIds = new Map(data.deviceResources.map((device) => [device.id, new Set((device.ports || []).map((port) => port.id))]));
  for (const scenario of data.testScenarios) {
    const deviceOf = new Map(scenario.roles.map((role) => [role.id, role.deviceId]));
    for (const segment of scenario.segments) {
      for (const item of segment.interfaces) {
        if (item.portId && !portIds.get(deviceOf.get(item.roleId) || "")?.has(item.portId)) item.portId = "";
      }
    }
  }
}

/**
 * Before catalog version 15 the lab kept its own copy of each device's ports and control ports. They move to the device
 * resources, keeping port IDs so cables stay attached; a port the device already has under the same name is reused.
 */
function moveLabPortsToDevices(data: CatalogData): void {
  const deviceById = new Map(data.deviceResources.map((device) => [device.id, device]));
  for (const lab of data.physicalLabs) {
    const renamed = new Map<string, string>();
    const key = (nodeId: string, portId: string) => `${nodeId}\u0000${portId}`;
    lab.nodes = lab.nodes.filter((node) => {
      if (node.kind !== "device") return true;
      const device = deviceById.get(node.id);
      if (!device) return false;
      device.ports ??= [];
      for (const port of node.ports || []) {
        const existing = device.ports.find((item) => item.id === port.id) || device.ports.find((item) => item.name.toLowerCase() === port.name.toLowerCase());
        if (existing) renamed.set(key(node.id, port.id), existing.id);
        else device.ports.push({ id: port.id, name: port.name, kind: port.kind, specification: "", note: port.note || "" });
      }
      for (const [controlId, labPortId] of Object.entries(node.controlPorts || {})) {
        const control = device.controlInterfaces.find((item) => item.id === controlId);
        const portId = renamed.get(key(node.id, labPortId)) || labPortId;
        if (control && !control.portId && device.ports.some((port) => port.id === portId)) control.portId = portId;
      }
      return false;
    });
    const move = (end: LabLinkEnd) => ({ nodeId: end.nodeId, portId: renamed.get(key(end.nodeId, end.portId)) || end.portId });
    lab.links = lab.links.map((link) => ({ ...link, a: move(link.a), b: move(link.b) }));
  }
}

function labSnapshot(lab: PhysicalLab): PhysicalLab | undefined {
  return lab.rules || lab.links.length || lab.nodes.some((node) => node.ports.length) ? lab : undefined;
}

/** Run lists go to the browser; the wiring snapshot is only needed by execution and diagnostics. */
function publicRun(run: TestRun): TestRun {
  const { physicalLabSnapshot: _snapshot, ...rest } = clone(run);
  return rest;
}

/**
 * A scenario without a topology is described by its texts alone, so preparation and checks are required. With one,
 * the platform sets up and checks the segments, and the texts hold only what it cannot work out.
 */
function scenarioTexts(input: Record<string, unknown>, hasTopology: boolean): Pick<TestScenario, "setupInstructions" | "verificationInstructions" | "cleanupInstructions"> {
  return {
    setupInstructions: hasTopology ? optionalText(input.setupInstructions, 20_000) : requiredText(input.setupInstructions, "场景准备", 20_000),
    verificationInstructions: hasTopology ? optionalText(input.verificationInstructions, 10_000) : requiredText(input.verificationInstructions, "场景检查", 10_000),
    cleanupInstructions: optionalText(input.cleanupInstructions, 10_000),
  };
}

function defaultScenarioId(productId: string): string {
  return `default-scenario-${productId}`;
}

function createDefaultScenario(product: Product, timestamp = new Date().toISOString()): TestScenario {
  return {
    id: defaultScenarioId(product.id),
    productId: product.id,
    isDefault: true,
    name: "默认场景",
    category: "默认",
    description: "不执行额外的场景搭建，直接使用绑定设备的当前配置执行用例。",
    roles: [],
    segments: [],
    parameters: [],
    setupInstructions: "",
    verificationInstructions: "确认用例所需设备及其控制接口可用。",
    cleanupInstructions: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function defaultData(): CatalogData {
  const timestamp = new Date().toISOString();
  const products = ["WKCJ-I", "WKCJ-II"].map((name) => ({
    id: randomUUID(),
    name,
    description: "",
    zentaoId: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  return {
    version: 17,
    products,
    testCases: [],
    deviceResources: [],
    physicalLabs: [],
    testScenarios: products.map((product) => createDefaultScenario(product, timestamp)),
    testOrders: [],
    testRuns: [],
  };
}

export class CatalogStore {
  private initializePromise?: Promise<void>;
  private mutationQueue: Promise<void> = Promise.resolve();
  private memoryData?: CatalogData;

  constructor(private readonly filePath: string) {}

  private async write(data: CatalogData): Promise<void> {
    if (this.memoryData) {
      this.memoryData = clone(data);
      return;
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  private async initialize(): Promise<void> {
    try {
      const original = await readFile(this.filePath, "utf8");
      const data = JSON.parse(original) as { version?: number };
      if (typeof data.version === "number" && data.version >= 1 && data.version < 17) {
        try {
          await writeFile(`${this.filePath}.v${data.version}.bak`, original, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.write(defaultData());
    }
  }

  private async read(): Promise<CatalogData> {
    if (this.memoryData) return clone(this.memoryData);
    this.initializePromise ??= this.initialize();
    await this.initializePromise;
    const data = JSON.parse(await readFile(this.filePath, "utf8")) as CatalogData & { version: number };
    if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].includes(data.version) || !Array.isArray(data.products) || !Array.isArray(data.testCases)) {
      throw new CatalogError("业务数据文件格式不正确", 500);
    }
    const sourceVersion = data.version;
    const legacyData = data as typeof data & { labEnvironments?: LegacyPhysicalEnvironment[]; physicalEnvironments?: LegacyPhysicalEnvironment[] };
    let physicalEnvironments = legacyData.physicalEnvironments ?? legacyData.labEnvironments ?? [];
    data.version = 17;
    data.deviceResources ??= [];
    data.physicalLabs = Array.isArray(data.physicalLabs) ? data.physicalLabs : [];
    delete legacyData.physicalEnvironments;
    delete legacyData.labEnvironments;
    data.testScenarios ??= [];
    data.testOrders ??= [];
    data.testRuns ??= [];
    const legacyOrders = data.testOrders as LegacyTestOrder[];
    legacyOrders.forEach((order) => {
      order.physicalEnvironmentId ??= order.environmentId || "";
    });

    const productIds = new Set(data.products.map((product) => product.id));
    const fallbackProductId = data.products
      .filter((product) => !product.archivedAt)
      .sort((left, right) => {
        const score = (productId: string) =>
          data.testCases.filter((item) => item.productId === productId && !item.archivedAt).length
          + data.testOrders.filter((item) => item.productId === productId && !item.archivedAt).length;
        return score(right.id) - score(left.id);
      })[0]?.id || data.products[0]?.id || "";
    const physicalEnvironmentOwners = new Map<string, string>();
    const scenarioOwners = new Map<string, string>();
    legacyOrders.forEach((order) => {
      if (order.physicalEnvironmentId && !physicalEnvironmentOwners.has(order.physicalEnvironmentId)) {
        physicalEnvironmentOwners.set(order.physicalEnvironmentId, order.productId);
      }
      if (order.scenarioId && !scenarioOwners.has(order.scenarioId)) scenarioOwners.set(order.scenarioId, order.productId);
    });
    physicalEnvironments = physicalEnvironments.map((physicalEnvironment) => ({
      ...physicalEnvironment,
      productId: productIds.has(physicalEnvironment.productId)
        ? physicalEnvironment.productId
        : physicalEnvironmentOwners.get(physicalEnvironment.id) || fallbackProductId,
    }));
    data.testScenarios = data.testScenarios.map((scenario) => ({
      ...scenario,
      isDefault: scenario.isDefault === true,
      productId: productIds.has(scenario.productId)
        ? scenario.productId
        : scenarioOwners.get(scenario.id) || fallbackProductId,
      roles: (scenario.roles || []).map((role) => ({
        id: role.id,
        key: role.key,
        deviceId: typeof role.deviceId === "string" ? role.deviceId : "",
      })),
      // Before catalog version 17 a scenario had no logical topology, only text.
      segments: Array.isArray(scenario.segments) ? scenario.segments : [],
    }));
    data.products.forEach((product) => {
      if (!data.testScenarios.some((scenario) => scenario.productId === product.id && scenario.isDefault)) {
        data.testScenarios.push(createDefaultScenario(product, product.createdAt));
      }
    });
    const scenarioById = new Map(data.testScenarios.map((scenario) => [scenario.id, scenario]));
    data.testCases = (data.testCases as LegacyTestCase[]).map((testCase) => {
      const scenario = testCase.scenarioId ? scenarioById.get(testCase.scenarioId) : undefined;
      let precondition = typeof testCase.precondition === "string" ? testCase.precondition : "";
      let steps = testCase.steps;
      if (sourceVersion < 10 && !precondition && testCase.source === "zentao" && steps.startsWith("前置条件：")) {
        const firstStepIndex = steps.indexOf("\n1. ");
        precondition = steps.slice("前置条件：".length, firstStepIndex >= 0 ? firstStepIndex : undefined).trim();
        steps = firstStepIndex >= 0 ? steps.slice(firstStepIndex + 1) : "禅道用例未提供测试步骤";
      }
      return {
        id: testCase.id,
        productId: testCase.productId,
        scenarioId: scenario?.productId === testCase.productId ? scenario.id : defaultScenarioId(testCase.productId),
        source: testCase.source === "zentao" && Number.isInteger(testCase.zentaoCaseId) ? "zentao" : "local",
        zentaoCaseId: Number.isInteger(testCase.zentaoCaseId) ? testCase.zentaoCaseId : undefined,
        lastImportedAt: typeof testCase.lastImportedAt === "string" ? testCase.lastImportedAt : undefined,
        name: testCase.name,
        precondition,
        steps,
        expectedResult: testCase.expectedResult,
        stepRows: testCase.stepRows === undefined ? stepRowsFromLegacy(steps, testCase.expectedResult) : parseStepRows(testCase.stepRows),
        createdAt: testCase.createdAt,
        updatedAt: testCase.updatedAt,
        archivedAt: testCase.archivedAt,
      };
    });
    const deviceOwners = new Map<string, string>();
    physicalEnvironments.forEach((physicalEnvironment) => {
      physicalEnvironment.deviceIds.forEach((deviceId) => {
        if (!deviceOwners.has(deviceId)) deviceOwners.set(deviceId, physicalEnvironment.productId);
      });
    });
    const productNameById = new Map(data.products.map((product) => [product.id, product.name]));
    data.deviceResources = (data.deviceResources as LegacyDeviceResource[]).map((device) => {
      const productId = productIds.has(device.productId) ? device.productId : deviceOwners.get(device.id) || fallbackProductId;
      const identity = isDeviceTemplateId(device.template)
        ? { template: device.template, description: device.description || "" }
        : migrateDeviceIdentity(device, productNameById.get(productId) || "");
      return {
        id: device.id,
        productId,
        name: device.name,
        ...identity,
        ports: device.ports || [],
        controlInterfaces: (device.controlInterfaces || []).map((control) => isControlKind(control.kind) && control.settings && typeof control.settings === "object"
          ? { id: String(control.id), name: control.name || "", kind: control.kind, ...(control.portId ? { portId: String(control.portId) } : {}), settings: Object.fromEntries(Object.entries(control.settings).map(([key, value]) => [key, String(value ?? "")])) }
          : controlFromLegacy({
              id: String(control.id),
              name: control.name || "",
              type: control.type === "relay" ? "other" : control.type || "other",
              address: control.address || "",
              username: control.username,
              password: control.password,
            })),
        createdAt: device.createdAt,
        updatedAt: device.updatedAt,
        archivedAt: device.archivedAt,
      };
    });

    moveLabPortsToDevices(data);
    // Before catalog version 16 each cable had a role picked by hand; it is now worked out when the lab is read.
    for (const lab of data.physicalLabs) lab.links = lab.links.map(({ id, a, b, note }) => ({ id, a, b, note: note || "" }));
    const deviceProductById = new Map(data.deviceResources.map((device) => [device.id, device.productId]));
    physicalEnvironments.forEach((physicalEnvironment) => {
      const allowedIds = new Set(
        physicalEnvironment.deviceIds.filter((deviceId) => deviceProductById.get(deviceId) === physicalEnvironment.productId),
      );
      physicalEnvironment.deviceIds = [...allowedIds];
      physicalEnvironment.connections = physicalEnvironment.connections.filter(
        (connection) => allowedIds.has(connection.sourceDeviceId) && allowedIds.has(connection.targetDeviceId),
      );
    });
    if (sourceVersion < 11) {
      // Retain legacy wiring as scene context without guessing device assignments.
      const deviceById = new Map(data.deviceResources.map((device) => [device.id, device]));
      for (const scenario of data.testScenarios) {
        const environmentIds = new Set(legacyOrders
          .filter((order) => order.productId === scenario.productId && order.caseIds.some((caseId) =>
            data.testCases.some((testCase) => testCase.id === caseId && testCase.scenarioId === scenario.id)))
          .map((order) => order.physicalEnvironmentId));
        const descriptions = physicalEnvironments
          .filter((environment) => environment.productId === scenario.productId && environmentIds.has(environment.id))
          .map((environment) => {
            const connections = environment.connections.map((connection) =>
              `${deviceById.get(connection.sourceDeviceId)?.name || connection.sourceDeviceId}.${connection.sourcePort} <-> ${deviceById.get(connection.targetDeviceId)?.name || connection.targetDeviceId}.${connection.targetPort}${connection.description ? `（${connection.description}）` : ""}`);
            return `原物理环境：${environment.name}\n${environment.description || ""}\n${connections.join("\n")}`.trim();
          });
        if (scenario.isDefault) {
          if (scenario.description === "不切换逻辑拓扑，直接使用所选物理环境执行用例。") {
            scenario.description = "不执行额外的场景搭建，直接使用绑定设备的当前配置执行用例。";
          }
          if (scenario.setupInstructions === "保持物理环境当前逻辑配置，不执行额外的场景搭建。") {
            scenario.setupInstructions = "";
          }
        }
        if (descriptions.length) scenario.description = [scenario.description, ...descriptions].filter(Boolean).join("\n\n");
      }
    }
    data.testOrders = legacyOrders.map((order) => {
      return {
        id: order.id,
        productId: order.productId,
        name: order.name,
        description: order.description || "",
        caseIds: order.caseIds,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        archivedAt: order.archivedAt,
      };
    });
    const testCaseById = new Map(data.testCases.map((testCase) => [testCase.id, testCase]));
    data.testRuns = (data.testRuns as LegacyTestRun[]).map((run) => {
      if (run.scenarioRuns && run.caseRuns.every((caseRun) => Boolean(caseRun.scenarioRunId))) {
        return {
          ...run,
          caseRuns: run.caseRuns.map((caseRun) => ({
            ...caseRun,
            preconditionSnapshot: caseRun.preconditionSnapshot || "",
          })),
        } as TestRun;
      }
      const runOrder = data.testOrders.find((order) => order.id === run.testOrderId);
      const scenarioRuns = new Map<string, ScenarioRun>();
      const caseRuns = run.caseRuns.map((caseRun) => {
        const testCase = testCaseById.get(caseRun.testCaseId);
        const scenario = scenarioById.get(testCase?.scenarioId || "");
        const scenarioId = scenario?.id || defaultScenarioId(testCase?.productId || runOrder?.productId || "legacy");
        let scenarioRun = scenarioRuns.get(scenarioId);
        if (!scenarioRun) {
          scenarioRun = {
            id: `scenario-run-${run.id}-${scenarioId}`,
            testScenarioId: scenarioId,
            scenarioNameSnapshot: scenario?.name || "默认场景",
            isDefault: scenario?.isDefault ?? true,
            status: run.status,
            outcome: run.outcome,
            roleBindings: {},
            parameterValues: {},
            caseRunIds: [],
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
          };
          scenarioRuns.set(scenarioId, scenarioRun);
        }
        scenarioRun.caseRunIds.push(caseRun.id);
        return {
          ...caseRun,
          scenarioRunId: scenarioRun.id,
          preconditionSnapshot: caseRun.preconditionSnapshot || "",
        };
      });
      return { ...run, scenarioRuns: [...scenarioRuns.values()], caseRuns };
    });
    return data;
  }

  private mutate<T>(operation: (data: CatalogData) => T | Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(async () => {
      const data = await this.read();
      const value = await operation(data);
      await this.write(data);
      return value;
    });
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assetRevision(data: CatalogData, productId: string): string {
    return createHash("sha256").update(JSON.stringify({
      product: data.products.find((item) => item.id === productId),
      cases: data.testCases.filter((item) => item.productId === productId),
      devices: data.deviceResources.filter((item) => item.productId === productId),
      scenarios: data.testScenarios.filter((item) => item.productId === productId),
      orders: data.testOrders.filter((item) => item.productId === productId),
    })).digest("hex");
  }

  private async evaluateAssetChanges(data: CatalogData, productId: string, changes: AssetChange[]) {
    if (!Array.isArray(changes) || !changes.length || changes.length > 200) throw new CatalogError("单次变更须包含 1 至 200 项操作");
    // Reuse the normal CRUD validators against an isolated snapshot, then commit once.
    const working = new CatalogStore(this.filePath);
    working.memoryData = clone(data);
    await working.getProduct(productId);
    const fields: Record<AssetKind, string[]> = {
      case: ["name", "scenarioId", "precondition", "steps", "expectedResult", "stepRows"],
      device: ["name", "template", "description", "ports", "controlInterfaces"],
      scenario: ["name", "category", "description", "roles", "segments", "parameters", "setupInstructions", "verificationInstructions", "cleanupInstructions", "caseIds"],
      order: ["name", "description", "caseIds"],
    };
    for (const change of changes) {
      if (!change || !Object.hasOwn(fields, change.kind) || !["create", "update", "delete"].includes(change.operation)) throw new CatalogError("资产操作不正确");
      if (change.operation !== "create" && !change.id) throw new CatalogError("修改或删除必须提供资产 ID");
      const values = recordValue(change.values);
      if (Object.keys(values).some((key) => !fields[change.kind].includes(key))) throw new CatalogError("包含不可修改的资产字段");
      const id = change.id || "";
      let existing: Record<string, unknown> = {};
      if (change.operation !== "create") {
        const state = working.memoryData!;
        const collection = change.kind === "case" ? state.testCases : change.kind === "device" ? state.deviceResources : change.kind === "scenario" ? state.testScenarios : state.testOrders;
        const asset = collection.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
        if (!asset) throw new CatalogError("资产不存在或不属于当前产品", 404);
        existing = { ...asset };
      }
      const input = { ...existing, ...values };
      switch (change.kind) {
        case "case":
          if (change.operation === "create") await working.createTestCase(productId, input);
          else if (change.operation === "update") await working.updateTestCase(productId, id, input);
          else await working.archiveTestCase(productId, id);
          break;
        case "device":
          if (change.operation === "create") await working.createDeviceResource(productId, input);
          else if (change.operation === "update") await working.updateDeviceResource(productId, id, input);
          else await working.archiveDeviceResource(productId, id);
          break;
        case "scenario":
          if (change.operation === "create") await working.createTestScenario(productId, input);
          else if (change.operation === "update") await working.updateTestScenario(productId, id, input);
          else await working.archiveTestScenario(productId, id);
          break;
        case "order":
          if (change.operation === "create") await working.createTestOrder(productId, input);
          else if (change.operation === "update") await working.updateTestOrder(productId, id, input);
          else await working.archiveTestOrder(productId, id);
      }
    }
    const next = working.memoryData!;
    const differences: AssetDifference[] = [];
    const collections = { case: "testCases", device: "deviceResources", scenario: "testScenarios", order: "testOrders" } as const;
    for (const kind of Object.keys(collections) as AssetKind[]) {
      const before = data[collections[kind]].filter((item) => item.productId === productId && !item.archivedAt);
      const after = next[collections[kind]].filter((item) => item.productId === productId && !item.archivedAt);
      for (const id of new Set([...before, ...after].map((item) => item.id))) {
        const previous = before.find((item) => item.id === id);
        const current = after.find((item) => item.id === id);
        const publicValue = (asset: typeof previous) => asset ? recordValue(kind === "device" ? this.publicDevice(next, asset as DeviceResource) : clone(asset)) : null;
        if (JSON.stringify(previous) !== JSON.stringify(current)) differences.push({ kind, id, name: current?.name || previous!.name, before: publicValue(previous), after: publicValue(current) });
      }
    }
    return { next, differences };
  }

  async previewAssetChanges(productId: string, changes: AssetChange[]): Promise<AssetPreview> {
    const data = await this.read();
    const { differences } = await this.evaluateAssetChanges(data, productId, changes);
    return { revision: this.assetRevision(data, productId), changes: clone(changes), differences };
  }

  async applyAssetChanges(productId: string, preview: AssetPreview): Promise<AssetDifference[]> {
    return this.mutate(async (data) => {
      if (this.assetRevision(data, productId) !== preview.revision) throw new CatalogError("产品资产已变化，请让助手重新读取并生成预览", 409);
      const { next, differences } = await this.evaluateAssetChanges(data, productId, preview.changes);
      Object.assign(data, next);
      return differences;
    });
  }

  async listProducts(): Promise<ProductSummary[]> {
    const data = await this.read();
    return data.products
      .filter((product) => !product.archivedAt)
      .map((product) => ({
        ...clone(product),
        caseCount: data.testCases.filter((testCase) => testCase.productId === product.id && !testCase.archivedAt).length,
        orderCount: data.testOrders.filter((order) => order.productId === product.id && !order.archivedAt).length,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  async getProduct(id: string): Promise<Product> {
    const data = await this.read();
    const product = data.products.find((item) => item.id === id && !item.archivedAt);
    if (!product) throw new CatalogError("产品不存在", 404);
    return clone(product);
  }

  async createProduct(input: Record<string, unknown>): Promise<Product> {
    return this.mutate((data) => {
      const name = requiredText(input.name, "产品名称", 120);
      if (data.products.some((item) => !item.archivedAt && item.name.toLowerCase() === name.toLowerCase())) {
        throw new CatalogError("产品名称已存在", 409);
      }
      const timestamp = new Date().toISOString();
      const product: Product = {
        id: randomUUID(),
        name,
        description: optionalText(input.description, 4_000),
        zentaoId: optionalText(input.zentaoId, 120),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.products.push(product);
      data.testScenarios.push(createDefaultScenario(product, timestamp));
      return clone(product);
    });
  }

  async updateProduct(id: string, input: Record<string, unknown>): Promise<Product> {
    return this.mutate((data) => {
      const product = data.products.find((item) => item.id === id && !item.archivedAt);
      if (!product) throw new CatalogError("产品不存在", 404);
      const name = requiredText(input.name, "产品名称", 120);
      if (data.products.some((item) => item.id !== id && !item.archivedAt && item.name.toLowerCase() === name.toLowerCase())) {
        throw new CatalogError("产品名称已存在", 409);
      }
      product.name = name;
      product.description = optionalText(input.description, 4_000);
      product.zentaoId = optionalText(input.zentaoId, 120);
      product.updatedAt = new Date().toISOString();
      return clone(product);
    });
  }

  async archiveProduct(id: string): Promise<void> {
    await this.mutate((data) => {
      const product = data.products.find((item) => item.id === id && !item.archivedAt);
      if (!product) throw new CatalogError("产品不存在", 404);
      const timestamp = new Date().toISOString();
      product.archivedAt = timestamp;
      product.updatedAt = timestamp;
      data.testCases.filter((item) => item.productId === id && !item.archivedAt).forEach((item) => (item.archivedAt = timestamp));
      data.deviceResources.filter((item) => item.productId === id && !item.archivedAt).forEach((item) => (item.archivedAt = timestamp));
      data.testScenarios.filter((item) => item.productId === id && !item.archivedAt).forEach((item) => (item.archivedAt = timestamp));
      data.testOrders.filter((item) => item.productId === id && !item.archivedAt).forEach((item) => (item.archivedAt = timestamp));
    });
  }

  async listTestCases(productId: string): Promise<TestCase[]> {
    await this.getProduct(productId);
    const data = await this.read();
    return data.testCases
      .filter((item) => item.productId === productId && !item.archivedAt)
      .map(clone)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getTestCase(productId: string, id: string): Promise<TestCase> {
    const data = await this.read();
    const testCase = data.testCases.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
    if (!testCase) throw new CatalogError("测试用例不存在", 404);
    return clone(testCase);
  }

  private validateTestCaseScenario(data: CatalogData, productId: string, value: unknown): string {
    const scenarioId = optionalText(value, 100) || defaultScenarioId(productId);
    const scenario = data.testScenarios.find(
      (item) => item.id === scenarioId && item.productId === productId && !item.archivedAt,
    );
    if (!scenario) throw new CatalogError("测试场景不属于当前产品或不存在", 404);
    return scenarioId;
  }

  private normalizeCaseSteps(input: Record<string, unknown>, current?: TestCase, allowEmptyExpectations = false): Pick<TestCase, "steps" | "expectedResult" | "stepRows"> {
    const legacyChanged = current && (input.steps !== undefined && input.steps !== current.steps || input.expectedResult !== undefined && input.expectedResult !== current.expectedResult);
    const rowsUnchanged = current && JSON.stringify(input.stepRows) === JSON.stringify(current.stepRows);
    // Legacy clients can send a full saved object with changed text and stale rows.
    if (input.stepRows !== undefined && !(legacyChanged && rowsUnchanged)) {
      try {
        const stepRows = parseStepRows(input.stepRows).map((row, index) => ({
          step: requiredText(row.step, `第 ${index + 1} 行步骤`, 20_000),
          expected: row.expected.trim(),
        }));
        if (!allowEmptyExpectations && !stepRows.some((row) => row.expected)) throw new CatalogError("用例步骤至少需要一个预期结果");
        const text = stepRowsToText(stepRows);
        requiredText(text.steps, "测试步骤", 20_000);
        if (allowEmptyExpectations) optionalText(text.expectedResult, 10_000);
        else requiredText(text.expectedResult, "预期结果", 10_000);
        return { stepRows, ...text };
      } catch (error) {
        throw error instanceof CatalogError ? error : new CatalogError(error instanceof Error ? error.message : "用例步骤格式不正确");
      }
    }
    const steps = requiredText(input.steps ?? current?.steps, "测试步骤", 20_000);
    const expectedResult = requiredText(input.expectedResult ?? current?.expectedResult, "预期结果", 10_000);
    return { steps, expectedResult, stepRows: stepRowsFromLegacy(steps, expectedResult) };
  }

  async createTestCase(productId: string, input: Record<string, unknown>): Promise<TestCase> {
    return this.mutate((data) => {
      const product = data.products.find((item) => item.id === productId && !item.archivedAt);
      if (!product) throw new CatalogError("产品不存在", 404);
      const timestamp = new Date().toISOString();
      const testCase: TestCase = {
        id: randomUUID(),
        productId,
        scenarioId: this.validateTestCaseScenario(data, productId, input.scenarioId),
        source: "local",
        name: requiredText(input.name, "用例名称", 200),
        precondition: optionalText(input.precondition, 10_000),
        ...this.normalizeCaseSteps(input),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.testCases.push(testCase);
      return clone(testCase);
    });
  }

  async updateTestCase(productId: string, id: string, input: Record<string, unknown>): Promise<TestCase> {
    return this.mutate((data) => {
      const testCase = data.testCases.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!testCase) throw new CatalogError("测试用例不存在", 404);
      testCase.scenarioId = this.validateTestCaseScenario(data, productId, input.scenarioId ?? testCase.scenarioId);
      testCase.name = requiredText(input.name, "用例名称", 200);
      testCase.precondition = optionalText(input.precondition, 10_000);
      Object.assign(testCase, this.normalizeCaseSteps(input, testCase));
      testCase.updatedAt = new Date().toISOString();
      return clone(testCase);
    });
  }

  async importZentaoTestCases(
    productId: string,
    importedCases: ImportedTestCaseInput[],
    overwriteExisting = false,
  ): Promise<TestCaseImportResult> {
    if (!Array.isArray(importedCases) || !importedCases.length) throw new CatalogError("请选择要导入的禅道用例");
    if (importedCases.length > 500) throw new CatalogError("单次最多导入 500 个禅道用例");
    return this.mutate((data) => {
      const product = data.products.find((item) => item.id === productId && !item.archivedAt);
      if (!product) throw new CatalogError("产品不存在", 404);
      const timestamp = new Date().toISOString();
      const uniqueCases = new Map<number, ImportedTestCaseInput>();
      importedCases.forEach((item) => {
        if (!Number.isInteger(item.zentaoCaseId) || item.zentaoCaseId <= 0) {
          throw new CatalogError("禅道用例 ID 不正确");
        }
        uniqueCases.set(item.zentaoCaseId, item);
      });

      const result: TestCaseImportResult = { created: 0, updated: 0, skipped: 0 };
      for (const item of uniqueCases.values()) {
        const existing = data.testCases.find(
          (testCase) => testCase.productId === productId
            && testCase.zentaoCaseId === item.zentaoCaseId
            && !testCase.archivedAt,
        );
        if (existing && !overwriteExisting) {
          result.skipped += 1;
          continue;
        }

        const name = requiredText(item.name, "用例名称", 200);
        const precondition = optionalText(item.precondition, 10_000);
        const caseSteps = this.normalizeCaseSteps(item as unknown as Record<string, unknown>, undefined, true);
        if (existing) {
          existing.source = "zentao";
          existing.name = name;
          existing.precondition = precondition;
          Object.assign(existing, caseSteps);
          existing.lastImportedAt = timestamp;
          existing.updatedAt = timestamp;
          result.updated += 1;
          continue;
        }

        data.testCases.push({
          id: randomUUID(),
          productId,
          scenarioId: defaultScenarioId(productId),
          source: "zentao",
          zentaoCaseId: item.zentaoCaseId,
          lastImportedAt: timestamp,
          name,
          precondition,
          ...caseSteps,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        result.created += 1;
      }
      return result;
    });
  }

  async archiveTestCase(productId: string, id: string): Promise<void> {
    await this.mutate((data) => {
      const testCase = data.testCases.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!testCase) throw new CatalogError("测试用例不存在", 404);
      const timestamp = new Date().toISOString();
      testCase.archivedAt = timestamp;
      testCase.updatedAt = timestamp;
      data.testOrders.forEach((order) => {
        if (!order.archivedAt && order.caseIds.includes(id)) {
          order.caseIds = order.caseIds.filter((caseId) => caseId !== id);
          order.updatedAt = timestamp;
        }
      });
    });
  }

  /**
   * Validates interfaces against each method's field list. An empty secret keeps the stored one; fields hidden by
   * the current choice (e.g. the password after switching API auth to a token) are cleared. The pre-version-14 shape
   * with type/address/username/password is still accepted and converted.
   */
  private normalizeControlInterfaces(value: unknown, existing: ControlInterface[] = []): ControlInterface[] {
    if (!Array.isArray(value)) throw new CatalogError("控制接口格式不正确");
    if (value.length > 30) throw new CatalogError("控制接口不能超过 30 个");
    const controls = value.map((item): ControlInterface => {
      let input = recordValue(item);
      if (input.kind === undefined && typeof input.type === "string") {
        if (!["web", "ssh", "telnet", "serial", "api", "other"].includes(input.type)) throw new CatalogError("控制接口类型不正确");
        const legacy = controlFromLegacy({
          id: optionalText(input.id, 100),
          name: optionalText(input.name, 120),
          type: input.type,
          address: requiredText(input.address, "接口地址", 2_048),
          username: optionalText(input.username, 300),
          password: optionalText(input.password, 1_000),
        });
        input = { ...legacy };
      }
      if (!isControlKind(input.kind)) throw new CatalogError("控制方式不正确");
      const kind: ControlKind = input.kind;
      const id = optionalText(input.id, 100) || randomUUID();
      const name = optionalText(input.name, 120);
      const label = name || CONTROL_KINDS[kind].label;
      const previous = existing.find((control) => control.id === id && control.kind === kind);
      const raw = recordValue(input.settings);
      const known = new Set(CONTROL_KINDS[kind].fields.map((field) => field.key));
      const unknown = Object.keys(raw).find((key) => !known.has(key));
      if (unknown) throw new CatalogError(`控制接口“${label}”包含未知字段 ${unknown}`);
      const settings: Record<string, string> = {};
      for (const field of CONTROL_KINDS[kind].fields) {
        const given = raw[field.key];
        let fieldValue = typeof given === "string" ? given.trim() : typeof given === "number" ? String(given) : "";
        if (fieldValue.length > (field.input === "textarea" ? 4_000 : 2_048)) throw new CatalogError(`控制接口“${label}”的${field.label}过长`);
        if (field.input === "secret" && !fieldValue) fieldValue = previous?.settings[field.key] || "";
        if (!fieldValue && field.default !== undefined) fieldValue = field.default;
        settings[field.key] = fieldValue;
      }
      for (const field of CONTROL_KINDS[kind].fields) {
        const fieldValue = settings[field.key];
        if (!isFieldShown(field, settings)) {
          settings[field.key] = "";
          continue;
        }
        if (!fieldValue) continue;
        if (field.input === "number" && !(/^\d{1,5}$/.test(fieldValue) && Number(fieldValue) >= 1 && Number(fieldValue) <= 65_535)) {
          throw new CatalogError(`控制接口“${label}”的${field.label}不正确`);
        }
        if (field.input === "select" && !field.options?.some((option) => option.value === fieldValue) && !field.accepts?.test(fieldValue)) {
          throw new CatalogError(`控制接口“${label}”的${field.label}不正确`);
        }
      }
      const missing = missingControlFields({ kind, settings });
      if (missing.length) throw new CatalogError(`控制接口“${label}”缺少${missing.map((field) => field.label).join("、")}`);
      const portId = Object.hasOwn(input, "portId") ? optionalText(input.portId, 100) : previous?.portId;
      return { id, name, kind, settings, ...(portId ? { portId } : {}) };
    });
    if (new Set(controls.map((control) => control.id)).size !== controls.length) throw new CatalogError("控制接口 ID 重复");
    return controls;
  }

  private publicDevice(data: CatalogData, device: DeviceResource): DeviceResourceSummary {
    const productName = data.products.find((product) => product.id === device.productId)?.name || "";
    return {
      ...clone(device),
      templateName: deviceTemplateName(device.template, productName),
      controlInterfaces: device.controlInterfaces.map((control) => {
        const secrets = secretKeys(control.kind);
        return {
          id: control.id,
          name: control.name,
          kind: control.kind,
          ...(control.portId ? { portId: control.portId } : {}),
          settings: Object.fromEntries(Object.entries(control.settings).filter(([key]) => !secrets.includes(key))),
          secretsSet: secrets.filter((key) => Boolean(control.settings[key])),
        };
      }),
    };
  }

  private deviceIdentity(data: CatalogData, productId: string, input: Record<string, unknown>, current?: DeviceResource): { template: DeviceTemplateId; description: string } {
    if (input.template !== undefined) {
      if (!isDeviceTemplateId(input.template)) throw new CatalogError("设备类型不正确");
      return { template: input.template, description: optionalText(input.description, 4_000) };
    }
    if (current) return { template: current.template, description: optionalText(input.description, 4_000) };
    // Older clients send free-text types and a model.
    const productName = data.products.find((product) => product.id === productId)?.name || "";
    const migrated = migrateDeviceIdentity(input, productName);
    if (migrated.description.length > 4_000) throw new CatalogError("设备说明不能超过 4000 个字符");
    return migrated;
  }

  async listDeviceResources(productId: string): Promise<DeviceResourceSummary[]> {
    await this.getProduct(productId);
    const data = await this.read();
    return data.deviceResources
      .filter((item) => item.productId === productId && !item.archivedAt)
      .map((item) => this.publicDevice(data, item))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  /** Internal execution snapshot. Never return this value from an HTTP route. */
  async getProductDeviceControlResources(productId: string): Promise<DeviceResource[]> {
    await this.getProduct(productId);
    const data = await this.read();
    return data.deviceResources
      .filter((item) => item.productId === productId && !item.archivedAt)
      .map(clone)
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  async createDeviceResource(productId: string, input: Record<string, unknown>): Promise<DeviceResourceSummary> {
    return this.mutate((data) => {
      if (!data.products.some((item) => item.id === productId && !item.archivedAt)) throw new CatalogError("产品不存在", 404);
      const name = requiredText(input.name, "设备名称", 160);
      uniqueName(data.deviceResources.filter((item) => item.productId === productId), name, "设备名称");
      const timestamp = new Date().toISOString();
      const device: DeviceResource = {
        id: randomUUID(),
        productId,
        name,
        ...this.deviceIdentity(data, productId, input),
        ports: this.normalizeDevicePorts(input.ports ?? []),
        controlInterfaces: this.normalizeControlInterfaces(input.controlInterfaces ?? []),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.validateDevicePortBindings(device);
      data.deviceResources.push(device);
      return this.publicDevice(data, device);
    });
  }

  async updateDeviceResource(productId: string, id: string, input: Record<string, unknown>): Promise<DeviceResourceSummary> {
    return this.mutate((data) => {
      const device = data.deviceResources.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!device) throw new CatalogError("设备资源不存在", 404);
      const name = requiredText(input.name, "设备名称", 160);
      uniqueName(data.deviceResources.filter((item) => item.productId === productId), name, "设备名称", id);
      const identity = this.deviceIdentity(data, productId, input, device);
      device.name = name;
      device.template = identity.template;
      device.description = identity.description;
      device.ports = input.ports === undefined ? device.ports || [] : this.normalizeDevicePorts(input.ports);
      device.controlInterfaces = this.normalizeControlInterfaces(input.controlInterfaces ?? [], device.controlInterfaces);
      this.validateDevicePortBindings(device);
      device.updatedAt = new Date().toISOString();
      this.dropCablesOfRemovedPorts(data, device);
      dropRemovedScenarioPorts(data);
      return this.publicDevice(data, device);
    });
  }

  /** A port removed from a device takes its cable with it, as removing the port in the lab would. */
  private dropCablesOfRemovedPorts(data: CatalogData, device: DeviceResource): void {
    const lab = data.physicalLabs.find((item) => item.productId === device.productId);
    if (!lab) return;
    const portIds = new Set((device.ports || []).map((port) => port.id));
    const links = lab.links.filter((link) => [link.a, link.b].every((end) => end.nodeId !== device.id || portIds.has(end.portId)));
    if (links.length === lab.links.length) return;
    lab.links = links;
    lab.updatedAt = device.updatedAt;
  }

  private normalizeDevicePorts(value: unknown): DevicePort[] {
    try { return parseDevicePorts(withDevicePortIds(value, randomUUID)); }
    catch (error) { throw new CatalogError(error instanceof Error ? error.message : "设备端口格式不正确"); }
  }

  private validateDevicePortBindings(device: DeviceResource): void {
    const ids = new Set((device.ports || []).map((port) => port.id));
    for (const control of device.controlInterfaces) {
      if (control.portId && !ids.has(control.portId)) throw new CatalogError(`控制方式“${control.name || CONTROL_KINDS[control.kind].label}”关联的设备端口不存在`);
    }
  }

  async archiveDeviceResource(productId: string, id: string): Promise<void> {
    await this.mutate((data) => {
      const device = data.deviceResources.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!device) throw new CatalogError("设备资源不存在", 404);
      if (data.testScenarios.some((item) => !item.archivedAt && item.roles.some((role) => role.deviceId === id))) {
        throw new CatalogError("设备正在被测试场景使用，不能删除", 409);
      }
      const lab = data.physicalLabs.find((item) => item.productId === productId);
      if (lab?.links.some((link) => link.a.nodeId === id || link.b.nodeId === id)) {
        throw new CatalogError("设备在物理环境中仍有接线，请先在物理环境中断开", 409);
      }
      device.archivedAt = new Date().toISOString();
      device.updatedAt = device.archivedAt;
      if (lab) lab.nodes = lab.nodes.filter((node) => node.id !== id);
    });
  }

  /** Every active product device appears as a node with its ports, names resolved and stale references dropped. */
  private physicalLabView(data: CatalogData, productId: string): PhysicalLab {
    const stored = data.physicalLabs.find((item) => item.productId === productId);
    const devices = data.deviceResources
      .filter((device) => device.productId === productId && !device.archivedAt)
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    const storedNodes = new Map((stored?.nodes || []).map((node) => [node.id, node]));
    const platform = storedNodes.get(PLATFORM_NODE_ID);
    const nodes: LabNode[] = [
      ...devices.map(deviceLabNode),
      {
        id: PLATFORM_NODE_ID,
        kind: "platform",
        name: platform?.kind === "platform" && platform.name ? platform.name : DEFAULT_PLATFORM_NAME,
        ports: clone(platform?.kind === "platform" ? platform.ports : []),
        controlPorts: {},
      },
      ...(stored?.nodes || []).filter((node) => node.kind === "external").map(clone),
    ];
    const portKeys = new Set(nodes.flatMap((node) => node.ports.map((port) => `${node.id}\u0000${port.id}`)));
    const exists = (end: LabLinkEnd) => portKeys.has(`${end.nodeId}\u0000${end.portId}`);
    const links = (stored?.links || []).filter((link) => exists(link.a) && exists(link.b)).map(clone);
    return {
      productId,
      rules: stored?.rules || "",
      nodes,
      links: withLinkRoles({ nodes, links }, new Map(devices.map((device) => [device.id, device.controlInterfaces]))),
      updatedAt: stored?.updatedAt || "",
    };
  }

  /**
   * Checks a lab sent by the page or produced by assistant operations. Device ports belong to the device resources: the
   * page cannot change them, so they are read from the devices; assistant operations can, and their edits come back in
   * `devicePorts` for the caller to save. The returned lab holds only platform and external nodes.
   */
  private normalizePhysicalLab(
    data: CatalogData,
    productId: string,
    input: Record<string, unknown>,
    deviceEdits = false,
  ): { lab: Omit<StoredPhysicalLab, "updatedAt">; devicePorts: DevicePortEdits } {
    const devices = new Map(data.deviceResources
      .filter((device) => device.productId === productId && !device.archivedAt)
      .map((device) => [device.id, device]));
    if (!Array.isArray(input.nodes)) throw new CatalogError("物理环境节点格式不正确");
    if (input.nodes.length > 300) throw new CatalogError("物理环境节点不能超过 300 个");
    const nodeNames = new Set([...devices.values()].map((device) => device.name.toLowerCase()));
    const nodes = input.nodes.map((item): LabNode => {
      const value = recordValue(item);
      const kind = optionalText(value.kind, 20);
      const id = optionalText(value.id, 100);
      let name = "";
      if (kind === "device") {
        const device = devices.get(id);
        if (!device) throw new CatalogError("物理环境包含不存在或不属于当前产品的设备，请刷新后重试");
        if (!deviceEdits) return deviceLabNode(device);
        name = device.name;
      } else if (kind === "platform") {
        if (id !== PLATFORM_NODE_ID) throw new CatalogError("平台节点标识不正确");
        name = optionalText(value.name, 60) || DEFAULT_PLATFORM_NAME;
      } else if (kind === "external") {
        name = requiredText(value.name, "外部节点名称", 60);
      } else {
        throw new CatalogError("物理环境节点类型不正确");
      }
      if (kind !== "device") {
        if (nodeNames.has(name.toLowerCase())) throw new CatalogError(`节点名称“${name}”与其他设备或节点重复`, 409);
        nodeNames.add(name.toLowerCase());
      }
      if (!Array.isArray(value.ports)) throw new CatalogError(`“${name}”的端口格式不正确`);
      if (value.ports.length > 500) throw new CatalogError(`“${name}”的端口不能超过 500 个`);
      const portNames = new Set<string>();
      const ports = value.ports.map((portItem): LabPort => {
        const port = recordValue(portItem);
        const portName = requiredText(port.name, `“${name}”的端口名称`, 80);
        const portKind = optionalText(port.kind, 20) as LabPortKind;
        if (!LAB_PORT_KINDS.includes(portKind)) throw new CatalogError(`端口“${name} ${portName}”的类型不正确`);
        if (portNames.has(portName.toLowerCase())) throw new CatalogError(`“${name}”的端口“${portName}”重复`, 409);
        portNames.add(portName.toLowerCase());
        return { id: optionalText(port.id, 100) || randomUUID(), name: portName, kind: portKind, note: optionalText(port.note, 1_000) };
      });
      if (new Set(ports.map((port) => port.id)).size !== ports.length) throw new CatalogError(`“${name}”的端口 ID 重复`);
      const portIds = new Set(ports.map((port) => port.id));
      const controlPorts: Record<string, string> = {};
      if (kind === "device") {
        const controlIds = new Set(devices.get(id)!.controlInterfaces.map((control) => control.id));
        for (const [controlId, portId] of Object.entries(recordValue(value.controlPorts))) {
          if (typeof portId !== "string" || !portId) continue;
          if (!controlIds.has(controlId)) throw new CatalogError(`“${name}”的控制接口已变化，请刷新后重试`, 409);
          if (!portIds.has(portId)) throw new CatalogError(`“${name}”的控制接口绑定了不存在的端口`);
          controlPorts[controlId] = portId;
        }
      }
      return { id: kind === "external" ? id || randomUUID() : id, kind: kind as LabNode["kind"], name: kind === "device" ? "" : name, ports, controlPorts };
    });
    if (new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new CatalogError("物理环境节点重复");
    if (!nodes.some((node) => node.kind === "platform")) {
      nodes.push({ id: PLATFORM_NODE_ID, kind: "platform", name: DEFAULT_PLATFORM_NAME, ports: [], controlPorts: {} });
    }
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const displayName = (node: LabNode) => node.kind === "device" ? devices.get(node.id)!.name : node.name;
    const resolveEnd = (value: unknown) => {
      const end = recordValue(value);
      const node = nodeById.get(optionalText(end.nodeId, 100));
      const port = node?.ports.find((item) => item.id === optionalText(end.portId, 100));
      if (!node || !port) throw new CatalogError("连线引用了不存在的端口，请刷新后重试");
      return { node, port, end: { nodeId: node.id, portId: port.id } };
    };
    if (!Array.isArray(input.links)) throw new CatalogError("物理环境连线格式不正确");
    if (input.links.length > 5_000) throw new CatalogError("物理环境连线不能超过 5000 条");
    const usedPorts = new Map<string, string>();
    const links = input.links.map((item): LabCable => {
      const value = recordValue(item);
      const a = resolveEnd(value.a);
      const b = resolveEnd(value.b);
      const label = (side: typeof a) => `${displayName(side.node)} ${side.port.name}`;
      if (a.node.id === b.node.id && a.port.id === b.port.id) throw new CatalogError(`端口“${label(a)}”不能连到自身`);
      if (!portKindsCompatible(a.port.kind, b.port.kind)) {
        const kindName = (kind: LabPortKind) => LAB_PORT_KIND_LABELS[kind].endsWith("口") ? LAB_PORT_KIND_LABELS[kind] : `${LAB_PORT_KIND_LABELS[kind]}口`;
        throw new CatalogError(`“${label(a)}”是${kindName(a.port.kind)}，不能连接${kindName(b.port.kind)}“${label(b)}”`);
      }
      for (const side of [a, b]) {
        const key = `${side.node.id}\u0000${side.port.id}`;
        if (usedPorts.has(key)) throw new CatalogError(`端口“${label(side)}”已经连接了${usedPorts.get(key)}，一个端口只能接一根线`, 409);
      }
      usedPorts.set(`${a.node.id}\u0000${a.port.id}`, `“${label(b)}”`);
      usedPorts.set(`${b.node.id}\u0000${b.port.id}`, `“${label(a)}”`);
      return { id: optionalText(value.id, 100) || randomUUID(), a: a.end, b: b.end, note: optionalText(value.note, 300) };
    });
    if (new Set(links.map((link) => link.id)).size !== links.length) throw new CatalogError("连线 ID 重复");
    const devicePorts: DevicePortEdits = new Map(nodes.filter((node) => node.kind === "device").map((node) => [node.id, { ports: node.ports, controlPorts: node.controlPorts }]));
    return { lab: { productId, rules: optionalText(input.rules, 10_000), nodes: nodes.filter((node) => node.kind !== "device"), links }, devicePorts };
  }

  async getPhysicalLab(productId: string): Promise<PhysicalLab> {
    await this.getProduct(productId);
    return this.physicalLabView(await this.read(), productId);
  }

  async updatePhysicalLab(productId: string, input: Record<string, unknown>): Promise<PhysicalLab> {
    return this.mutate((data) => {
      if (!data.products.some((item) => item.id === productId && !item.archivedAt)) throw new CatalogError("产品不存在", 404);
      const index = data.physicalLabs.findIndex((item) => item.productId === productId);
      const current = index >= 0 ? data.physicalLabs[index] : undefined;
      if (typeof input.baseUpdatedAt === "string" && input.baseUpdatedAt !== (current?.updatedAt || "")) {
        throw new CatalogError("物理环境已在其他地方修改，请刷新后重试", 409);
      }
      const lab: StoredPhysicalLab = { ...this.normalizePhysicalLab(data, productId, input).lab, updatedAt: new Date().toISOString() };
      if (index >= 0) data.physicalLabs[index] = lab;
      else data.physicalLabs.push(lab);
      return this.physicalLabView(data, productId);
    });
  }

  /**
   * Applies assistant operations to the current lab and words the result; nothing is saved. Port edits on device nodes
   * come back as updated device resources.
   */
  private evaluateLabChanges(data: CatalogData, productId: string, operations: LabOperation[]): { lab: Omit<StoredPhysicalLab, "updatedAt">; deviceResources: DeviceResource[]; changes: LabChange[] } {
    const before = this.physicalLabView(data, productId);
    const devices = data.deviceResources.filter((device) => device.productId === productId && !device.archivedAt);
    const { lab, devicePorts } = this.normalizePhysicalLab(data, productId, { ...applyLabOperations(before, operations, devices) }, true);
    const deviceResources = withDevicePortEdits(data.deviceResources, devicePorts, new Date().toISOString());
    const after = this.physicalLabView({
      ...data,
      deviceResources,
      physicalLabs: [...data.physicalLabs.filter((item) => item.productId !== productId), { ...lab, updatedAt: before.updatedAt }],
    }, productId);
    const changes = diffPhysicalLab(before, after, devices);
    if (!changes.length) throw new CatalogError("这些操作不会改变物理环境");
    return { lab, deviceResources, changes };
  }

  async previewPhysicalLabChanges(productId: string, operations: LabOperation[]): Promise<LabPreview> {
    await this.getProduct(productId);
    const { changes } = this.evaluateLabChanges(await this.read(), productId, operations);
    return { operations: clone(operations), changes };
  }

  /** Saves a confirmed preview only if replaying it on the current lab still gives exactly what was shown. */
  async applyPhysicalLabChanges(productId: string, preview: LabPreview): Promise<LabChange[]> {
    return this.mutate((data) => {
      if (!data.products.some((item) => item.id === productId && !item.archivedAt)) throw new CatalogError("产品不存在", 404);
      const { lab, deviceResources, changes } = this.evaluateLabChanges(data, productId, preview.operations);
      if (JSON.stringify(changes) !== JSON.stringify(preview.changes)) throw new CatalogError("物理环境已变化，请让助手重新读取并生成预览", 409);
      const index = data.physicalLabs.findIndex((item) => item.productId === productId);
      const saved: StoredPhysicalLab = { ...lab, updatedAt: new Date().toISOString() };
      if (index >= 0) data.physicalLabs[index] = saved;
      else data.physicalLabs.push(saved);
      data.deviceResources = deviceResources;
      dropRemovedScenarioPorts(data);
      return changes;
    });
  }

  private normalizeScenarioRoles(data: CatalogData, productId: string, value: unknown, allowEmpty = false): ScenarioRole[] {
    if (!Array.isArray(value) || (!allowEmpty && !value.length)) throw new CatalogError("测试场景至少需要一个设备角色");
    if (value.length > 30) throw new CatalogError("设备角色不能超过 30 个");
    const roles = value.map((item): ScenarioRole => {
      const input = recordValue(item);
      const key = requiredText(input.key, "角色标识", 80);
      if (!/^[a-z][a-z0-9_-]*$/i.test(key)) throw new CatalogError("角色标识只能包含字母、数字、下划线和连字符");
      return {
        id: optionalText(input.id, 100) || randomUUID(),
        key,
        deviceId: requiredText(input.deviceId, "绑定设备", 100),
      };
    });
    if (new Set(roles.map((item) => item.key.toLowerCase())).size !== roles.length) throw new CatalogError("角色标识不能重复");
    if (new Set(roles.map((item) => item.id)).size !== roles.length) throw new CatalogError("设备角色 ID 不能重复");
    if (new Set(roles.map((item) => item.deviceId)).size !== roles.length) throw new CatalogError("同一场景不能重复绑定设备");
    const deviceIds = new Set(data.deviceResources.filter((device) => device.productId === productId && !device.archivedAt).map((device) => device.id));
    if (roles.some((role) => !deviceIds.has(role.deviceId))) throw new CatalogError("绑定设备不属于当前产品或不存在");
    return roles;
  }

  /**
   * Checks the shape of the logical topology: names, VLANs, address formats and that each interface belongs to a role
   * and maps to a port of that role's device. Whether the wiring can carry it is checked when a run is created.
   */
  private normalizeScenarioSegments(data: CatalogData, value: unknown, roles: ScenarioRole[]): ScenarioSegment[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 50) throw new CatalogError("网段格式不正确，且不能超过 50 个");
    const roleById = new Map(roles.map((role) => [role.id, role]));
    const segmentNames = new Set<string>();
    const segments = value.map((item): ScenarioSegment => {
      const input = recordValue(item);
      const name = requiredText(input.name, "网段名称", 40);
      if (segmentNames.has(name.toLowerCase())) throw new CatalogError(`网段名称“${name}”重复`);
      segmentNames.add(name.toLowerCase());
      const vlan = optionalText(input.vlan, 10);
      if (vlan && !isVlanId(vlan)) throw new CatalogError(`网段“${name}”的 VLAN 须为 1–4094`);
      const subnet = optionalText(input.subnet, 40);
      if (subnet && !parseSubnet(subnet)) throw new CatalogError(`网段“${name}”的地址范围格式应为 192.168.181.0/24`);
      if (!Array.isArray(input.interfaces) || input.interfaces.length > 50) throw new CatalogError(`网段“${name}”的接口格式不正确，且不能超过 50 个`);
      const interfaces = input.interfaces.map((entry) => {
        const value = recordValue(entry);
        const role = roleById.get(optionalText(value.roleId, 100));
        if (!role) throw new CatalogError(`网段“${name}”中有接口没有对应的角色`);
        const interfaceName = requiredText(value.name, `网段“${name}”的接口名`, 40);
        const address = optionalText(value.address, 40);
        if (address && ipv4ToNumber(address) === undefined) throw new CatalogError(`${role.key} ${interfaceName} 的地址格式不正确`);
        const portId = optionalText(value.portId, 100);
        const device = data.deviceResources.find((candidate) => candidate.id === role.deviceId);
        if (portId && !device?.ports?.some((port) => port.id === portId)) throw new CatalogError(`${role.key} ${interfaceName} 选择的端口不属于绑定的设备，请重新选择`);
        return { id: optionalText(value.id, 100) || randomUUID(), roleId: role.id, name: interfaceName, address, portId };
      });
      return { id: optionalText(input.id, 100) || randomUUID(), name, vlan, subnet, interfaces };
    });
    if (new Set(segments.flatMap((segment) => [segment.id, ...segment.interfaces.map((item) => item.id)])).size !== segments.reduce((count, segment) => count + 1 + segment.interfaces.length, 0)) {
      throw new CatalogError("网段或接口 ID 重复");
    }
    return segments;
  }

  private normalizeScenarioParameters(value: unknown): ScenarioParameter[] {
    if (!Array.isArray(value)) throw new CatalogError("场景参数格式不正确");
    if (value.length > 100) throw new CatalogError("场景参数不能超过 100 个");
    const parameters = value.map((item) => {
      const input = recordValue(item);
      const key = requiredText(input.key, "参数标识", 80);
      if (!/^[a-z][a-z0-9_.-]*$/i.test(key)) throw new CatalogError("参数标识格式不正确");
      return {
        id: optionalText(input.id, 100) || randomUUID(),
        key,
        name: requiredText(input.name, "参数名称", 120),
        defaultValue: optionalText(input.defaultValue, 1_000),
      };
    });
    if (new Set(parameters.map((item) => item.key.toLowerCase())).size !== parameters.length) {
      throw new CatalogError("参数标识不能重复");
    }
    return parameters;
  }

  private validateScenarioCaseIds(data: CatalogData, productId: string, value: unknown): string[] {
    if (!Array.isArray(value)) throw new CatalogError("关联用例格式不正确");
    if (value.length > 10_000) throw new CatalogError("单个场景关联用例不能超过 10000 个");
    if (value.some((item) => typeof item !== "string")) throw new CatalogError("关联用例 ID 格式不正确");
    const caseIds = [...new Set(value as string[])];
    const validIds = new Set(
      data.testCases.filter((item) => item.productId === productId && !item.archivedAt).map((item) => item.id),
    );
    if (caseIds.some((caseId) => !validIds.has(caseId))) {
      throw new CatalogError("关联用例包含其他产品或不存在的用例");
    }
    return caseIds;
  }

  async listTestScenarios(productId: string): Promise<TestScenario[]> {
    await this.getProduct(productId);
    const data = await this.read();
    return data.testScenarios
      .filter((item) => item.productId === productId && !item.archivedAt)
      .map(clone)
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name, "zh-CN"));
  }

  async createTestScenario(productId: string, input: Record<string, unknown>): Promise<TestScenario> {
    return this.mutate((data) => {
      if (!data.products.some((item) => item.id === productId && !item.archivedAt)) throw new CatalogError("产品不存在", 404);
      const name = requiredText(input.name, "场景名称", 160);
      uniqueName(data.testScenarios.filter((item) => item.productId === productId), name, "场景名称");
      const timestamp = new Date().toISOString();
      const roles = this.normalizeScenarioRoles(data, productId, input.roles);
      const segments = this.normalizeScenarioSegments(data, input.segments, roles);
      const scenario: TestScenario = {
        id: randomUUID(),
        productId,
        isDefault: false,
        name,
        category: requiredText(input.category, "功能分类", 120),
        description: optionalText(input.description, 4_000),
        roles,
        segments,
        parameters: this.normalizeScenarioParameters(input.parameters ?? []),
        ...scenarioTexts(input, segments.length > 0),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.testScenarios.push(scenario);
      return clone(scenario);
    });
  }

  async updateTestScenario(productId: string, id: string, input: Record<string, unknown>): Promise<TestScenario> {
    return this.mutate((data) => {
      const scenario = data.testScenarios.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!scenario) throw new CatalogError("测试场景不存在", 404);
      const name = scenario.isDefault ? scenario.name : requiredText(input.name, "场景名称", 160);
      const caseIds = input.caseIds === undefined ? undefined : this.validateScenarioCaseIds(data, productId, input.caseIds);
      uniqueName(data.testScenarios.filter((item) => item.productId === productId), name, "场景名称", id);
      const timestamp = new Date().toISOString();
      scenario.name = name;
      scenario.category = scenario.isDefault ? scenario.category : requiredText(input.category, "功能分类", 120);
      scenario.description = optionalText(input.description, 4_000);
      scenario.roles = this.normalizeScenarioRoles(data, productId, input.roles, scenario.isDefault);
      // The default scenario sets nothing up, so it has no topology either.
      scenario.segments = scenario.isDefault ? [] : this.normalizeScenarioSegments(data, input.segments === undefined ? scenario.segments : input.segments, scenario.roles);
      scenario.parameters = this.normalizeScenarioParameters(input.parameters ?? []);
      if (scenario.isDefault) {
        scenario.setupInstructions = "";
        scenario.verificationInstructions = optionalText(input.verificationInstructions, 10_000);
        scenario.cleanupInstructions = optionalText(input.cleanupInstructions, 10_000);
      } else Object.assign(scenario, scenarioTexts(input, scenario.segments.length > 0));
      scenario.updatedAt = timestamp;
      if (caseIds) {
        const selectedIds = new Set(caseIds);
        data.testCases
          .filter((testCase) => testCase.productId === productId && !testCase.archivedAt)
          .forEach((testCase) => {
            const nextScenarioId = selectedIds.has(testCase.id)
              ? id
              : testCase.scenarioId === id
                ? defaultScenarioId(productId)
                : testCase.scenarioId;
            if (nextScenarioId !== testCase.scenarioId) {
              testCase.scenarioId = nextScenarioId;
              testCase.updatedAt = timestamp;
            }
          });
      }
      return clone(scenario);
    });
  }

  async archiveTestScenario(productId: string, id: string): Promise<void> {
    await this.mutate((data) => {
      const scenario = data.testScenarios.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!scenario) throw new CatalogError("测试场景不存在", 404);
      if (scenario.isDefault) throw new CatalogError("默认场景不能删除", 409);
      if (data.testCases.some((testCase) => testCase.scenarioId === id && !testCase.archivedAt)) {
        throw new CatalogError("测试场景正在被测试用例使用，不能删除", 409);
      }
      scenario.archivedAt = new Date().toISOString();
      scenario.updatedAt = scenario.archivedAt;
    });
  }

  private validateOrderCases(data: CatalogData, productId: string, value: unknown): string[] {
    if (!Array.isArray(value)) throw new CatalogError("请选择测试用例");
    const caseIds = [...new Set(value.filter((item): item is string => typeof item === "string"))];
    if (!caseIds.length) throw new CatalogError("测试单至少需要一个测试用例");
    const productCases = data.testCases.filter((item) => item.productId === productId && !item.archivedAt);
    const caseById = new Map(productCases.map((item) => [item.id, item]));
    const validIds = new Set(caseById.keys());
    if (caseIds.some((id) => !validIds.has(id))) throw new CatalogError("测试单包含不属于该产品的用例");
    const groups = new Map<string, string[]>();
    for (const caseId of caseIds) {
      const scenarioId = caseById.get(caseId)!.scenarioId;
      const group = groups.get(scenarioId) || [];
      group.push(caseId);
      groups.set(scenarioId, group);
    }
    return [...groups.values()].flat();
  }

  async createTestOrder(productId: string, input: Record<string, unknown>): Promise<TestOrder> {
    return this.mutate((data) => {
      if (!data.products.some((item) => item.id === productId && !item.archivedAt)) {
        throw new CatalogError("产品不存在", 404);
      }
      const timestamp = new Date().toISOString();
      const order: TestOrder = {
        id: randomUUID(),
        productId,
        name: requiredText(input.name, "测试单名称", 200),
        description: optionalText(input.description, 4_000),
        caseIds: this.validateOrderCases(data, productId, input.caseIds),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.testOrders.push(order);
      return clone(order);
    });
  }

  async updateTestOrder(productId: string, id: string, input: Record<string, unknown>): Promise<TestOrder> {
    return this.mutate((data) => {
      const order = data.testOrders.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!order) throw new CatalogError("测试单不存在", 404);
      order.name = requiredText(input.name, "测试单名称", 200);
      order.description = optionalText(input.description, 4_000);
      order.caseIds = this.validateOrderCases(data, productId, input.caseIds);
      order.updatedAt = new Date().toISOString();
      return clone(order);
    });
  }

  async archiveTestOrder(productId: string, id: string): Promise<void> {
    await this.mutate((data) => {
      const order = data.testOrders.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!order) throw new CatalogError("测试单不存在", 404);
      order.archivedAt = new Date().toISOString();
      order.updatedAt = order.archivedAt;
    });
  }

  private publicOrder(data: CatalogData, order: TestOrder): TestOrderSummary {
    const product = data.products.find((item) => item.id === order.productId);
    const latestRun = data.testRuns
      .filter((run) => run.testOrderId === order.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return {
      ...clone(order),
      productName: product?.name || "已删除产品",
      caseCount: order.caseIds.length,
      latestRun: latestRun ? publicRun(latestRun) : undefined,
    };
  }

  async listTestOrders(productId: string): Promise<TestOrderSummary[]> {
    await this.getProduct(productId);
    const data = await this.read();
    return data.testOrders
      .filter((order) => order.productId === productId && !order.archivedAt)
      .map((order) => this.publicOrder(data, order))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getTestOrder(productId: string, id: string): Promise<TestOrder> {
    const data = await this.read();
    const order = data.testOrders.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
    if (!order) throw new CatalogError("测试单不存在", 404);
    return clone(order);
  }

  async getTestOrderDetail(productId: string, id: string): Promise<TestOrderDetail> {
    const data = await this.read();
    const order = data.testOrders.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
    if (!order) throw new CatalogError("测试单不存在", 404);
    const cases = order.caseIds
      .map((caseId) => data.testCases.find((item) => item.id === caseId))
      .filter((item): item is TestCase => Boolean(item))
      .map(clone);
    const runs = data.testRuns
      .filter((run) => run.testOrderId === id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 30)
      .map(publicRun);
    return {
      ...this.publicOrder(data, order),
      cases,
      runs,
    };
  }

  async getTestRunReportContext(productId: string, runId: string): Promise<TestRunReportContext> {
    const data = await this.read();
    const product = data.products.find((item) => item.id === productId && !item.archivedAt);
    if (!product) throw new CatalogError("产品不存在", 404);
    const testRun = data.testRuns.find((item) => item.id === runId);
    const testOrder = testRun
      ? data.testOrders.find((item) => item.id === testRun.testOrderId && item.productId === productId)
      : undefined;
    if (!testRun || !testOrder) throw new CatalogError("测试执行记录不存在或不属于当前产品", 404);
    return clone({
      product: { id: product.id, name: product.name },
      testOrder: { id: testOrder.id, name: testOrder.name, description: testOrder.description },
      testRun,
    });
  }

  async getTestOrderExecutionContext(id: string): Promise<TestOrderExecutionContext> {
    const data = await this.read();
    const order = data.testOrders.find((item) => item.id === id && !item.archivedAt);
    if (!order) throw new CatalogError("测试单不存在", 404);
    return {
      productName: data.products.find((product) => product.id === order.productId)?.name || "",
      devices: data.deviceResources.filter((device) => device.productId === order.productId && !device.archivedAt).map(clone),
      scenarios: data.testScenarios
        .filter((scenario) => scenario.productId === order.productId && !scenario.archivedAt)
        .map(clone),
      physicalLab: this.physicalLabView(data, order.productId),
    };
  }

  async getDiagnosticExecutionContext(
    productId: string,
    testRunId: string,
    caseRunId: string,
  ): Promise<DiagnosticExecutionContext> {
    const data = await this.read();
    const product = data.products.find((item) => item.id === productId && !item.archivedAt);
    if (!product) throw new CatalogError("产品不存在", 404);
    const testRun = data.testRuns.find((item) => item.id === testRunId);
    const testOrder = testRun
      ? data.testOrders.find((item) => item.id === testRun.testOrderId && item.productId === productId)
      : undefined;
    if (!testRun || !testOrder) throw new CatalogError("测试执行记录不存在或不属于当前产品", 404);
    const caseRun = testRun.caseRuns.find((item) => item.id === caseRunId);
    if (!caseRun) throw new CatalogError("用例执行记录不存在", 404);
    const scenarioRun = testRun.scenarioRuns.find((item) => item.id === caseRun.scenarioRunId);
    if (!scenarioRun) throw new CatalogError("场景执行记录不存在", 404);
    const scenario = scenarioRun.scenarioSnapshot || data.testScenarios.find((item) => item.id === scenarioRun.testScenarioId && item.productId === productId);
    const boundDeviceIds = new Set(Object.values(scenarioRun.roleBindings));
    const devices = data.deviceResources.filter((device) => device.productId === productId && !device.archivedAt && boundDeviceIds.has(device.id));

    return clone({
      product,
      testOrder,
      testRun,
      caseRun,
      scenarioRun,
      scenario,
      devices,
      scenarios: scenario ? [scenario] : [],
      physicalLab: testRun.physicalLabSnapshot || this.physicalLabView(data, productId),
      physicalLabSource: testRun.physicalLabSnapshot ? "snapshot" : "current",
    });
  }

  async createTestRun(runId: string, testOrderId: string, selectedCaseIds?: string[]): Promise<TestRun> {
    return this.mutate((data) => {
      const order = data.testOrders.find((item) => item.id === testOrderId && !item.archivedAt);
      if (!order) throw new CatalogError("测试单不存在", 404);
      const caseIds = selectedCaseIds?.length ? selectedCaseIds : order.caseIds;
      if (caseIds.some((caseId) => !order.caseIds.includes(caseId))) {
        throw new CatalogError("所选用例不属于该测试单");
      }
      const cases = caseIds.map((caseId) => data.testCases.find((item) => item.id === caseId && !item.archivedAt));
      if (cases.some((item) => !item)) throw new CatalogError("测试单中存在已删除的测试用例");
      const labView = this.physicalLabView(data, order.productId);
      const productDevices = data.deviceResources.filter((device) => device.productId === order.productId && !device.archivedAt);
      const caseRuns: CaseRun[] = [];
      const scenarioRunsById = new Map<string, ScenarioRun>();
      for (const testCase of cases as TestCase[]) {
        const scenario = data.testScenarios.find(
          (item) => item.id === testCase.scenarioId && item.productId === order.productId && !item.archivedAt,
        );
        if (!scenario) throw new CatalogError(`用例“${testCase.name}”关联的测试场景不存在`);
        let scenarioRun = scenarioRunsById.get(scenario.id);
        if (!scenarioRun) {
          try {
            this.normalizeScenarioRoles(data, order.productId, scenario.roles, scenario.isDefault);
          } catch (error) {
            throw new CatalogError(`场景“${scenario.name}”设备角色配置无效：${error instanceof Error ? error.message : "请重新绑定设备"}`);
          }
          const problems = topologyProblems(analyzeScenarioTopology({ lab: labView, roles: scenario.roles, devices: productDevices, segments: scenario.segments }));
          if (problems.length) throw new CatalogError(`场景“${scenario.name}”的拓扑还有 ${problems.length} 个问题，需要先处理：${problems[0].text}`);
          scenarioRun = {
            id: randomUUID(),
            testScenarioId: scenario.id,
            scenarioNameSnapshot: scenario.name,
            isDefault: scenario.isDefault,
            status: "queued",
            roleBindings: Object.fromEntries(scenario.roles.map((role) => [role.key, role.deviceId])),
            scenarioSnapshot: clone(scenario),
            parameterValues: Object.fromEntries(
              scenario.parameters.map((parameter) => [parameter.key, parameter.defaultValue]),
            ),
            caseRunIds: [],
          };
          scenarioRunsById.set(scenario.id, scenarioRun);
        }
        const caseRun: CaseRun = {
          id: randomUUID(),
          testCaseId: testCase.id,
          scenarioRunId: scenarioRun.id,
          caseNameSnapshot: testCase.name,
          preconditionSnapshot: testCase.precondition,
          stepsSnapshot: testCase.steps,
          expectedResultSnapshot: testCase.expectedResult,
          stepRowsSnapshot: clone(testCase.stepRows),
          status: "queued",
        };
        scenarioRun.caseRunIds.push(caseRun.id);
        caseRuns.push(caseRun);
      }
      const scenarioRuns = [...scenarioRunsById.values()];
      const caseRunById = new Map(caseRuns.map((caseRun) => [caseRun.id, caseRun]));
      const executionCaseRuns = scenarioRuns.flatMap((scenarioRun) =>
        scenarioRun.caseRunIds.map((caseRunId) => caseRunById.get(caseRunId)!),
      );
      const physicalLabSnapshot = labSnapshot(labView);
      const run: TestRun = {
        id: runId,
        testOrderId,
        triggerType: selectedCaseIds?.length ? "single" : "all",
        status: "queued",
        scenarioRuns,
        caseRuns: executionCaseRuns,
        ...(physicalLabSnapshot ? { physicalLabSnapshot } : {}),
        createdAt: new Date().toISOString(),
      };
      data.testRuns.push(run);
      return clone(run);
    });
  }

  async updateTestRun(id: string, update: (run: TestRun) => void): Promise<TestRun> {
    return this.mutate((data) => {
      const run = data.testRuns.find((item) => item.id === id);
      if (!run) throw new CatalogError("执行记录不存在", 404);
      update(run);
      return clone(run);
    });
  }

  async failInterruptedTestRuns(reason: string): Promise<string[]> {
    return this.mutate((data) => {
      const finishedAt = new Date().toISOString();
      const interruptedRunIds: string[] = [];
      for (const run of data.testRuns) {
        if (run.status !== "queued" && run.status !== "running") continue;
        interruptedRunIds.push(run.id);
        run.status = "failed";
        run.outcome = "failed";
        run.finishedAt = finishedAt;
        run.caseRuns.forEach((caseRun) => {
          if (caseRun.status !== "queued" && caseRun.status !== "running") return;
          const wasRunning = caseRun.status === "running";
          caseRun.status = "failed";
          caseRun.outcome = "failed";
          caseRun.summary = wasRunning ? `执行中断：${reason}` : `未执行：${reason}`;
          caseRun.finishedAt = finishedAt;
        });
        run.scenarioRuns.forEach((scenarioRun) => {
          if (scenarioRun.status !== "queued" && scenarioRun.status !== "running") return;
          const prefix = scenarioRun.status === "running" ? "执行中断" : "未执行";
          scenarioRun.status = "failed";
          scenarioRun.outcome = "failed";
          scenarioRun.summary = scenarioRun.summary
            ? `${scenarioRun.summary}\n${prefix}：${reason}`
            : `${prefix}：${reason}`;
          scenarioRun.finishedAt = finishedAt;
        });
      }
      return interruptedRunIds;
    });
  }
}

export const catalogStore = new CatalogStore(path.resolve(process.cwd(), ".data", "catalog.json"));
