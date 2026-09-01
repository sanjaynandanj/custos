export const DEMO_POLICY = {
  version: 1,
  id: "custos-cloud-run-demo-v1",
  default: "deny",
  rules: [
    {
      id: "block-shell",
      when: { tool: { regex: "^shell\\." } },
      decision: "deny",
      reason: "Shell access is forbidden for this agent",
    },
    {
      id: "block-destructive-customer-actions",
      when: { tool: "customer.delete" },
      decision: "deny",
      reason: "Customer deletion requires human approval",
    },
    {
      id: "block-large-refunds",
      when: { tool: "payment.refund", "args.amount": { gt: 100 } },
      decision: "deny",
      reason: "Refunds above $100 require human approval",
    },
    {
      id: "allow-small-refunds",
      when: { tool: "payment.refund", "args.amount": { lte: 100 } },
      decision: "allow",
      reason: "Refund is within the autonomous approval limit",
    },
    {
      id: "allow-customer-reads",
      when: { tool: "customer.read" },
      decision: "allow",
      reason: "Read-only customer access is permitted",
    },
    {
      id: "allow-support-tickets",
      when: { tool: "support.ticket.create" },
      decision: "allow",
      reason: "Creating support tickets is permitted",
    },
  ],
};

export const ALLOWED_TOOLS = [
  "customer.read",
  "customer.delete",
  "payment.refund",
  "support.ticket.create",
  "shell.exec",
];
