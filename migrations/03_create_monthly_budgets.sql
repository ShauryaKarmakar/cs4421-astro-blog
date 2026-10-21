-- Store each user's base allocation for an individual category and month.
-- Rollover is derived from these immutable period amounts and eligible expenses.
CREATE TABLE IF NOT EXISTS monthly_budgets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (btrim(category) <> '' AND char_length(category) <= 100),
  budget_month DATE NOT NULL CHECK (EXTRACT(DAY FROM budget_month) = 1),
  base_amount NUMERIC(12, 2) NOT NULL CHECK (base_amount > 0),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT monthly_budgets_user_category_month_unique
    UNIQUE (user_id, category, budget_month)
);

CREATE INDEX IF NOT EXISTS idx_monthly_budgets_user_month
  ON monthly_budgets (user_id, budget_month);
