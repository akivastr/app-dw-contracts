-- A change outside the contract schemas. This should NOT open a PR.
ALTER TABLE public.app_users ADD COLUMN last_login_at timestamptz;
