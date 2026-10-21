-- Preserve the previous category-budget rows, and carry their monthly totals
-- into the new one-budget-per-user/month model.
ALTER TABLE monthly_budgets RENAME TO monthly_category_budgets_legacy;

ALTER INDEX IF EXISTS idx_monthly_budgets_user_month
  RENAME TO idx_monthly_category_budgets_legacy_user_month;

CREATE TABLE monthly_budgets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  budget_month DATE NOT NULL CHECK (EXTRACT(DAY FROM budget_month) = 1),
  base_amount NUMERIC NOT NULL CHECK (base_amount > 0 AND scale(base_amount) <= 2),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT monthly_budgets_user_month_unique UNIQUE (user_id, budget_month)
);

INSERT INTO monthly_budgets (user_id, budget_month, base_amount, created_at, updated_at)
SELECT user_id,
       budget_month,
       SUM(base_amount),
       MIN(created_at),
       MAX(updated_at)
FROM monthly_category_budgets_legacy
GROUP BY user_id, budget_month;

CREATE INDEX idx_monthly_budgets_user_month
  ON monthly_budgets (user_id, budget_month);

COMMENT ON TABLE monthly_category_budgets_legacy IS
  'Archived source records preserved when category budgets were consolidated into one monthly budget.';
