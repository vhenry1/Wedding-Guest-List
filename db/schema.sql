-- Wedding Guest List schema. Every row is owned by a Neon Auth user (the JWT `sub`).

CREATE TABLE IF NOT EXISTS profiles (
  user_id      text PRIMARY KEY,
  couple       text NOT NULL DEFAULT '',
  wedding_date date,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS households (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL,
  name          text NOT NULL,
  priority      smallint NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 4),
  side          text NOT NULL DEFAULT 'Bride' CHECK (side IN ('Bride', 'Groom', 'Both')),
  group_name    text NOT NULL DEFAULT '',
  email         text NOT NULL DEFAULT '',
  phone         text NOT NULL DEFAULT '',
  address       text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT '',
  save_the_date boolean NOT NULL DEFAULT false,
  invite_sent   boolean NOT NULL DEFAULT false,
  -- [{ name, type: 'adult'|'child', rsvp: 'pending'|'attending'|'declined' }]
  guests        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(guests) = 'array'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS households_user_id_idx ON households (user_id, priority, name);
