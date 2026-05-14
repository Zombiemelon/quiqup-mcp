import { describe, it, expect, vi, beforeEach } from "vitest";

const quiqupLastmileGetMock = vi.fn();

vi.mock("@/lib/quiqup", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    quiqupLastmileGet: quiqupLastmileGetMock,
    getQuiqupReadyJwt: vi.fn(async (_userId: string) => "test-jwt-for-msw"),
  };
});

interface Captured {
  name?: string;
  meta?: {
    title?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  };
  handler?: (args: unknown, extra: unknown) => Promise<unknown>;
}

function makeFakeServer(captured: Captured) {
  return {
    registerTool: (
      name: string,
      meta: Captured["meta"],
      handler: Captured["handler"],
    ) => {
      captured.name = name;
      captured.meta = meta;
      captured.handler = handler;
    },
  };
}

const extraWithUser = {
  authInfo: {
    extra: { clerkAuth: { subject: "user_test" } },
  },
};

const sampleResponse = {
  current_page: 1,
  per_page: 5,
  total: 2,
  total_pages: 1,
  results: [
    {
      id: 1001,
      uuid: "uuid-1",
      state: "pending",
      partner_order_id: "PO-1",
      brand_name: "BrandX",
      created_at: "2026-05-10T10:00:00Z",
      state_updated_at: "2026-05-10T11:00:00Z",
      destination: { contact_name: "Alice", emirate: "Dubai" },
      item_quantity_count: 3,
    },
    {
      id: 1002,
      uuid: "uuid-2",
      state: "pending",
      partner_order_id: null,
      brand_name: null,
      created_at: "2026-05-11T10:00:00Z",
      state_updated_at: "2026-05-11T11:00:00Z",
      // no destination, no item_quantity_count — exercise nullish branches
    },
  ],
};

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

describe("recent_orders", () => {
  beforeEach(() => {
    quiqupLastmileGetMock.mockReset();
  });

  describe("registration shape", () => {
    it("registers under the expected name with title/description/inputSchema", async () => {
      const { registerRecentOrders } = await import(
        "../lib/tools/recent-orders"
      );
      const captured: Captured = {};
      registerRecentOrders(makeFakeServer(captured) as never);

      expect(captured.name).toBe("recent_orders");
      expect(captured.meta?.title).toBeDefined();
      expect(captured.meta?.description).toMatch(/last-mile|orders/i);
      expect(captured.meta?.inputSchema).toBeDefined();
      const schema = captured.meta!.inputSchema!;
      expect(schema).toHaveProperty("state");
      expect(schema).toHaveProperty("from");
      expect(schema).toHaveProperty("to");
      expect(schema).toHaveProperty("limit");
      expect(typeof captured.handler).toBe("function");
    });
  });

  describe("happy path with defaults", () => {
    it("fills state=pending, limit=5, from=7d ago, to=today and projects rows", async () => {
      quiqupLastmileGetMock.mockResolvedValueOnce(sampleResponse);

      const { registerRecentOrders } = await import(
        "../lib/tools/recent-orders"
      );
      const captured: Captured = {};
      registerRecentOrders(makeFakeServer(captured) as never);

      const result = (await captured.handler!({}, extraWithUser)) as {
        content: Array<{ type: string; text: string }>;
      };

      // Verify call shape into quiqupLastmileGet
      expect(quiqupLastmileGetMock).toHaveBeenCalledTimes(1);
      const [path, query, userId] = quiqupLastmileGetMock.mock.calls[0];
      expect(path).toBe("/orders");
      expect(userId).toBe("user_test");
      expect(query).toMatchObject({
        "filters[state]": "pending",
        page: 1,
        per_page: 5,
      });
      expect(query.from).toBe(isoDaysAgo(7));
      expect(query.to).toBe(isoDaysAgo(0));

      // Verify projection
      expect(result.content).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.query).toEqual({
        state: "pending",
        from: isoDaysAgo(7),
        to: isoDaysAgo(0),
        limit: 5,
      });
      expect(parsed.total_matching).toBe(2);
      expect(parsed.returned).toBe(2);
      expect(parsed.orders).toHaveLength(2);
      expect(parsed.orders[0]).toEqual({
        id: 1001,
        uuid: "uuid-1",
        state: "pending",
        partner_order_id: "PO-1",
        brand: "BrandX",
        contact: "Alice",
        emirate: "Dubai",
        items: 3,
        created_at: "2026-05-10T10:00:00Z",
        state_updated_at: "2026-05-10T11:00:00Z",
      });
      // Second row exercises the null/optional branches
      expect(parsed.orders[1].contact).toBeNull();
      expect(parsed.orders[1].emirate).toBeNull();
      expect(parsed.orders[1].items).toBeNull();
      expect(parsed.orders[1].brand).toBeNull();
    });

    it("honours explicit args overriding the defaults", async () => {
      quiqupLastmileGetMock.mockResolvedValueOnce({
        ...sampleResponse,
        results: [],
        total: 0,
      });

      const { registerRecentOrders } = await import(
        "../lib/tools/recent-orders"
      );
      const captured: Captured = {};
      registerRecentOrders(makeFakeServer(captured) as never);

      await captured.handler!(
        { state: "delivered", from: "2026-01-01", to: "2026-01-31", limit: 25 },
        extraWithUser,
      );

      const [, query] = quiqupLastmileGetMock.mock.calls[0];
      expect(query).toMatchObject({
        "filters[state]": "delivered",
        from: "2026-01-01",
        to: "2026-01-31",
        per_page: 25,
        page: 1,
      });
    });
  });

  describe("no-userId path", () => {
    it("returns the explicit error JSON without calling quiqupLastmileGet", async () => {
      const { registerRecentOrders } = await import(
        "../lib/tools/recent-orders"
      );
      const captured: Captured = {};
      registerRecentOrders(makeFakeServer(captured) as never);

      const result = (await captured.handler!({}, { authInfo: undefined })) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(quiqupLastmileGetMock).not.toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toMatch(/no userId/i);
    });
  });
});
