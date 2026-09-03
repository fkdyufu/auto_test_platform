import { Router } from "express";
import { CatalogError, catalogStore } from "./catalog-store.js";
import { readZentaoSettings, toPublicZentaoSettings } from "./settings-store.js";
import { getZentaoClient } from "./zentao-client.js";

export const zentaoRouter = Router();

async function productContext(productId: string) {
  const product = await catalogStore.getProduct(productId);
  if (!/^\d+$/.test(product.zentaoId) || Number(product.zentaoId) <= 0) {
    throw new CatalogError("请先为当前产品填写有效的禅道产品 ID", 409);
  }
  const settings = await readZentaoSettings();
  if (!toPublicZentaoSettings(settings).configured) {
    throw new CatalogError("请先完成禅道设置", 409);
  }
  return {
    zentaoProductId: Number(product.zentaoId),
    client: getZentaoClient(settings),
  };
}

function positiveInteger(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(number) || number <= 0) throw new CatalogError(`${label}不正确`);
  return number;
}

zentaoRouter.get("/products/:productId/zentao/test-tasks", async (request, response, next) => {
  try {
    const { client, zentaoProductId } = await productContext(request.params.productId);
    response.json(await client.listTestTasks(zentaoProductId));
  } catch (error) {
    next(error);
  }
});

zentaoRouter.get("/products/:productId/zentao/test-cases", async (request, response, next) => {
  try {
    const { client, zentaoProductId } = await productContext(request.params.productId);
    const source = typeof request.query.source === "string" ? request.query.source : "product";
    if (source !== "product" && source !== "testTask") throw new CatalogError("禅道用例导入范围不正确");
    if (source === "testTask") {
      const testTaskId = positiveInteger(request.query.testTaskId, "禅道测试单 ID");
      response.json(await client.listTestTaskCases(testTaskId, zentaoProductId));
      return;
    }
    response.json(await client.listProductCases(zentaoProductId));
  } catch (error) {
    next(error);
  }
});

zentaoRouter.post("/products/:productId/zentao/import-cases", async (request, response, next) => {
  try {
    const { client, zentaoProductId } = await productContext(request.params.productId);
    const rawCaseIds: unknown[] = Array.isArray(request.body?.caseIds) ? request.body.caseIds : [];
    if (!rawCaseIds.length) throw new CatalogError("请选择要导入的禅道用例");
    if (rawCaseIds.length > 500) throw new CatalogError("单次最多导入 500 个禅道用例");
    const caseIds = [...new Set(rawCaseIds.map((value) => positiveInteger(value, "禅道用例 ID")))];
    const importedCases = await client.getCasesImportData(caseIds, zentaoProductId);
    response.json(await catalogStore.importZentaoTestCases(
      request.params.productId,
      importedCases,
      request.body?.overwrite === true,
    ));
  } catch (error) {
    next(error);
  }
});
