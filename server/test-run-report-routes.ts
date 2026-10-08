import { Router } from "express";
import { CatalogError, CatalogStore, catalogStore } from "./catalog-store.js";
import { DOCX_CONTENT_TYPE, generateTestRunDocx, testRunReportFilename } from "./test-run-docx.js";

export function createTestRunReportRouter(store: CatalogStore = catalogStore): Router {
  const router = Router();
  router.get("/products/:productId/test-runs/:runId/report.docx", async (request, response, next) => {
    try {
      const context = await store.getTestRunReportContext(request.params.productId, request.params.runId);
      if (context.testRun.status === "queued" || context.testRun.status === "running") {
        throw new CatalogError("测试执行结束后才能导出报告", 409);
      }
      const buffer = await generateTestRunDocx(context);
      const filename = testRunReportFilename(context);
      response.set({
        "Content-Type": DOCX_CONTENT_TYPE,
        "Content-Disposition": `attachment; filename="test-report.docx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-store",
      });
      response.send(buffer);
    } catch (error) {
      next(error);
    }
  });
  return router;
}
