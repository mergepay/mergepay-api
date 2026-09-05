  

    
        tags: ["expenses"],
        summary: "List group expenses",
        description: "Return the paginated, filterable list of expenses for a group, including optional totals and status filtering.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
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
    async (req) => {
      const auth = requireUser(req);
      const { id: groupId } = idParamSchema.parse(req.params);
      const query = expenseListQuerySchema.parse(req.query ?? {});

      await requireMembership(groupId, auth.id);

      const { items, meta } = await listGroupExpenses(groupId, query, expenseInclude);
      return { expenses: items.map(serializeExpense), meta };
    }
  );

  app.get(
    "/expenses/:id",
    {
      schema: {
        tags: ["expenses"],
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
          },
        },
      },
    },
    {: "object",
            properties: {
              expense: {
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
          },
        },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const body = updateExpenseSchema.parse(req.body);

      const updated = await prisma.$transaction(async (tx) => {
        const expense = await tx.expense.findUnique({ where: { id } });
        if (!expense) throw Errors.notFound("Expense not found");
        const ctx = await requireMembership(expense.groupId, auth.id, tx);
        if (expense.payerUserId !== auth.id && ctx.role !== "admin") {
          throw Errors.forbidden("Only the payer or an admin can edit this expense");
        }

        const result = await tx.expense.update({
          where: { id },
          data: {
            ...(body.title !== undefined && { title: body.title }),
            ...(body.description !== undefined && { description: body.description }),
            ...(body.memo !== undefined && { memo: body.memo }),
            ...(body.receiptUrl !== undefined && { receiptUrl: body.receiptUrl }),
          },
          include: expenseInclude,
        });

        await auditTx(tx, {
          userId: auth.id,
          groupId: expense.groupId,
          action: "expense.update",
          entityType: "expense",
          entityId: id,
        });

        return result;
      });
      return { expense: serializeExpense(updated) };
    }
  );

  app.delete(
    "/expenses/:id",
    {
      schema: {
        tags: ["expenses"],
        summary: "Delete an expense",
        description: "Delete an expense after confirming the caller has rights and the expense has no settled shares that would make deletion unsafe.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: { ok: { type: "boolean" } },
          },
        },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const { id } = idParamSchema.parse(req.params);

      await prisma.$transaction(async (tx) => {
        const found = await tx.expense.findUnique({
          where: { id },
          include: { shares: true },
        });
       
