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

catalogRouter.put("/test-cases/:id", async (request, response, next) => {
  try {
    response.json(await catalogStore.updateTestCase(request.params.id, body(request.body)));
  } catch (error) {
    next(error);
  }
});

catalogRouter.delete("/test-cases/:id", async (request, response, next) => {
  try {
    await catalogStore.archiveTestCase(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

catalogRouter.get("/test-orders", async (_request, response, next) => {
  try {
    response.json(await catalogStore.listTestOrders());
  } catch (error) {
    next(error);
  }
});

catalogRouter.post("/test-orders", async (request, response, next) => {
  try {
    const order = await catalogStore.createTestOrder(body(request.body));
    response.status(201).json(await catalogStore.getTestOrderDetail(order.id));
  } catch (error) {
    next(error);
  }
});

catalogRouter.get("/test-orders/:id", async (request, response, next) => {
  try {
    response.json(await catalogStore.getTestOrderDetail(request.params.id));
  } catch (error) {
    next(error);
  }
});

catalogRouter.put("/test-orders/:id", async (request, response, next) => {
  try {
    await catalogStore.updateTestOrder(request.params.id, body(request.body));
    response.json(await catalogStore.getTestOrderDetail(request.params.id));
  } catch (error) {
    next(error);
  }
});

catalogRouter.delete("/test-orders/:id", async (request, response, next) => {
  try {
    await catalogStore.archiveTestOrder(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});
