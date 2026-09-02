import { Router } from "express";
import { catalogStore } from "./catalog-store.js";

export const catalogRouter = Router();

function body(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

catalogRouter.get("/products", async (_request, response, next) => {
  try {
    response.json(await catalogStore.listProducts());
  } catch (error) {
    next(error);
  }
});

catalogRouter.post("/products", async (request, response, next) => {
  try {
    response.status(201).json(await catalogStore.createProduct(body(request.body)));
  } catch (error) {
    next(error);
  }
});

catalogRouter.get("/products/:id", async (request, response, next) => {
  try {
    response.json(await catalogStore.getProduct(request.params.id));
  } catch (error) {
    next(error);
  }
});

catalogRouter.put("/products/:id", async (request, response, next) => {
  try {
    response.json(await catalogStore.updateProduct(request.params.id, body(request.body)));
  } catch (error) {
    next(error);
  }
});

catalogRouter.delete("/products/:id", async (request, response, next) => {
  try {
    await catalogStore.archiveProduct(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

catalogRouter.get("/products/:id/cases", async (request, response, next) => {
  try {
    response.json(await catalogStore.listTestCases(request.params.id));
  } catch (error) {
    next(error);
  }
});

catalogRouter.post("/products/:id/cases", async (request, response, next) => {
  try {
    response.status(201).json(await catalogStore.createTestCase(request.params.id, body(request.body)));
  } catch (error) {
    next(error);
  }
});

catalogRouter.put("/products/:productId/test-cases/:id", async (request, response, next) => {
  try {
    response.json(await catalogStore.updateTestCase(request.params.productId, request.params.id, body(request.body)));
  } catch (error) {
    next(error);
  }
});

catalogRouter.delete("/products/:productId/test-cases/:id", async (request, response, next) => {
  try {
    await catalogStore.archiveTestCase(request.params.productId, request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

catalogRouter.get("/products/:productId/device-resources", async (request, response, next) => {
  try {
    response.json(await catalogStore.listDeviceResources(request.params.productId));
  } catch (error) {
    next(error);
  }
});

catalogRouter.post("/products/:productId/device-resources", async (request, response, next) => {
  try {
    response.status(201).json(await catalogStore.createDeviceResource(request.params.productId, body(request.body)));
  } catch (error) {
    next(error);
  }
});

catalogRouter.put("/products/:productId/device-resources/:id", async (request, response, next) => {
  try {
    response.json(await catalogStore.updateDeviceResource(request.params.productId, request.params.id, body(request.body)));
  } catch (error) {
    next(error);
  }
});

catalogRouter.delete("/products/:productId/device-resources/:id", async (request, response, next) => {
  try {
    await catalogStore.archiveDeviceResource(request.params.productId, request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

catalogRouter.get("/products/:productId/lab-environments", async (request, response, next) => {
  try {
    response.json(await catalogStore.listLabEnvironments(request.params.productId));
  } catch (error) {
    next(error);
  }
});

catalogRouter.post("/products/:productId/lab-environments", async (request, response, next) => {
  try {
    response.status(201).json(await catalogStore.createLabEnvironment(request.params.productId, body(request.body)));
  } catch (error) {
    next(error);
  }
});

catalogRouter.put("/products/:productId/lab-environments/:id", async (request, response, next) => {
  try {
    response.json(await catalogStore.updateLabEnvironment(request.params.productId, request.params.id, body(request.body)));
  } catch (error) {
    next(error);
  }
});

catalogRouter.delete("/products/:productId/lab-environments/:id", async (request, response, next) => {
  try {
    await catalogStore.archiveLabEnvironment(request.params.productId, request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

catalogRouter.get("/products/:productId/test-scenarios", async (request, response, next) => {
  try {
    response.json(await catalogStore.listTestScenarios(request.params.productId));
  } catch (error) {
    next(error);
  }
});

catalogRouter.post("/products/:productId/test-scenarios", async (request, response, next) => {
  try {
    response.status(201).json(await catalogStore.createTestScenario(request.params.productId, body(request.body)));
  } catch (error) {
    next(error);
  }
});

catalogRouter.put("/products/:productId/test-scenarios/:id", async (request, response, next) => {
  try {
    response.json(await catalogStore.updateTestScenario(request.params.productId, request.params.id, body(request.body)));
  } catch (error) {
    next(error);
  }
});

catalogRouter.delete("/products/:productId/test-scenarios/:id", async (request, response, next) => {
  try {
    await catalogStore.archiveTestScenario(request.params.productId, request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

catalogRouter.get("/products/:productId/test-orders", async (request, response, next) => {
  try {
    response.json(await catalogStore.listTestOrders(request.params.productId));
  } catch (error) {
    next(error);
  }
});

catalogRouter.post("/products/:productId/test-orders", async (request, response, next) => {
  try {
    const order = await catalogStore.createTestOrder(request.params.productId, body(request.body));
    response.status(201).json(await catalogStore.getTestOrderDetail(request.params.productId, order.id));
  } catch (error) {
    next(error);
  }
});

catalogRouter.get("/products/:productId/test-orders/:id", async (request, response, next) => {
  try {
    response.json(await catalogStore.getTestOrderDetail(request.params.productId, request.params.id));
  } catch (error) {
    next(error);
  }
});

catalogRouter.put("/products/:productId/test-orders/:id", async (request, response, next) => {
  try {
    await catalogStore.updateTestOrder(request.params.productId, request.params.id, body(request.body));
    response.json(await catalogStore.getTestOrderDetail(request.params.productId, request.params.id));
  } catch (error) {
    next(error);
  }
});

catalogRouter.delete("/products/:productId/test-orders/:id", async (request, response, next) => {
  try {
    await catalogStore.archiveTestOrder(request.params.productId, request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});
