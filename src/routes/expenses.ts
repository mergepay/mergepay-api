: { id: { type: "string", minLength: 1, maxLength: 64 } },
          additionalProperties: false,
        },
        querystring: {
          type: "object",
          properties: {
            cursor: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 50 },
            order: { type: "string", enum: ["asc", "desc"] },
            asset: { type: ["string", "null"] },
            status: { type: ["string", "null"], enum: ["SETTLED", "PENDING", "OVERDUE"] },
            startDate: { type: ["string", "null"], format: "date-time" },
            endDate: { type: ["string", "null"], format: "date-time" },
            includeTotal: { type: ["boolean", "string", "null"] },
          },
          additionalProperties: true,
        },
        response: {
          200: {
            type: "object",
            properties: {
              expenses: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    groupId: { type: "string" },
                    payerUserId: { type: "string" },
                    title: { type: "string" },
                    description: { type: ["string", "null"] },
                    amount: { type: "string" },
                    assetCode: { type: "string" },
                    assetIssuer: { type: ["string", "null"] },
                    splitType: { type: "string" },
                    memo: { type: ["string", "null"] },
                    receiptUrl: { type: ["string", "null"] },
                    createdAt: { type: "string", format: "date-time" },
                  },
                },
              },
              meta: {
                type: "object",
                properties: {
                  nextCursor: { type: ["string", "null"] },
                  hasMore: { type: "boolean" },
                  total: { type: ["integer", "null"] },
                },
              },
            },
          },
        },
      },
    },
    async "],
        summary: "Get an expense by id",
        description: "Fetch one expense and its participant shares after verifying the caller is a group member.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              expense: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  groupId: { type: "string" },
                  payerUserId: { type: "string" },
                  title: { type: "string" },
                  description: { type: ["string", "null"] },
                  