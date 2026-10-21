-- migrations/01_init.sql
-- Initial schema. Existing data is not dropped; apply this through the migration
-- runner rather than using IF NOT EXISTS as a substitute for schema validation.

-- Enable the uuid-ossp extension if not already enabled (for UUID generation in SQL)
-- We are generating UUIDs in the app, so we don't strictly need this, but it's handy.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create index on email for faster lookup
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Create sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_hash TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create index on token_hash for session lookup
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
-- Create index on expires_at for cleaning up expired sessions
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- Create profiles table
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'USD',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  university TEXT,
  course TEXT,
  academic_year TEXT,
  city TEXT,
  country TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create index on user_id for profiles
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles(user_id);

-- Comment on tables
COMMENT ON TABLE users IS 'Stores user account information';
COMMENT ON TABLE sessions IS 'Stores session tokens for authentication';
COMMENT ON TABLE profiles IS 'Stores user profile and preferences';