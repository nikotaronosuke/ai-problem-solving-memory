-- P3-04: clients and their credentials.
--
-- Three layers, deliberately separate. An `owner` owns Memory. A `client` is
-- something that connects on the owner's behalf — an assistant, a CLI, a
-- future adapter. A credential proves a client, and a client may hold several
-- so one can be replaced without an outage.
--
-- Collapsing any two of those would cost something concrete. Owner and client
-- as one means an AI vendor's account becomes the ownership boundary, which
-- the specification refuses outright. Client and credential as one means
-- revoking a credential deletes the identity that used it, and rotation
-- becomes a gap in service rather than an overlap.
--
-- No raw credential is stored here, and none can be recovered from what is.
-- The secret half of a token is hashed on the way in; the row keeps a digest
-- and a public selector, and the token itself exists once, in the output of
-- the command that issued it.
--
-- Deliberately absent: `last_used_at`, permissions, any provider or vendor
-- column, and anything resembling an external service's credential. The first
-- would make every read a write. The second is a real feature that belongs to
-- whichever phase actually needs it, and inventing the column now would fix
-- its meaning before anyone has decided it. The last two are Tool Gateway's,
-- not Memory's.

create table public.clients (
  client_id uuid primary key,

  -- Owned, and restricted like everything else: an owner with clients cannot
  -- be removed out from under them.
  owner_id uuid not null
    constraint clients_owner_id_fkey
    references public.owners (owner_id)
    on delete restrict,

  -- What a person calls this connection when deciding whether to revoke it.
  -- Free text on purpose: "Claude Code on the laptop" is the useful answer,
  -- and an enumeration of vendors would be a list that is wrong within a
  -- month and would quietly make the vendor part of the identity.
  label text not null
    constraint clients_label_not_blank check (btrim(label, E' \t\r\n\f\v') <> ''),

  created_at timestamptz not null default now()
);

comment on table public.clients is
  'Something that connects to Memory on an owner''s behalf. Distinct from the '
  'owner: an AI vendor account is never the ownership boundary.';

comment on column public.clients.label is
  'Human-readable, for deciding what to revoke. Not an identifier and not a '
  'vendor enumeration.';

create index clients_owner_id_idx on public.clients (owner_id);

create table public.client_credentials (
  credential_id uuid primary key,

  -- Credentials belong to a client, and a client to an owner. One direction
  -- only: `owner_id` is deliberately not duplicated here, because two copies
  -- of the same fact can disagree and the copy is what an attacker would want
  -- to change.
  client_id uuid not null
    constraint client_credentials_client_id_fkey
    references public.clients (client_id)
    on delete restrict,

  -- The public half of the token, stored in the clear on purpose: it is how a
  -- presented credential finds its row in one indexed lookup. It proves
  -- nothing by itself, and finding it in the database is not a leak.
  token_lookup text not null
    constraint client_credentials_token_lookup_format
    check (token_lookup ~ '^[A-Za-z0-9_-]{16}$'),

  -- SHA-256 of the secret half. Thirty-two bytes, checked here so a row that
  -- could never match anything cannot be written by mistake.
  token_hash bytea not null
    constraint client_credentials_token_hash_length
    check (octet_length(token_hash) = 32),

  created_at timestamptz not null default now(),

  -- Set once, and from then on the credential authenticates nothing. Kept
  -- rather than deleted so that revocation is a fact with a time on it.
  revoked_at timestamptz,

  constraint client_credentials_token_lookup_key unique (token_lookup)
);

comment on table public.client_credentials is
  'Bearer credentials for a client. The secret half is never stored: only its '
  'SHA-256 digest and a public selector used to find the row.';

comment on column public.client_credentials.token_lookup is
  'Public selector. Plaintext by design, and not a secret.';

comment on column public.client_credentials.token_hash is
  'SHA-256 of the secret half. The secret itself exists once, in the output of '
  'the command that issued it.';

create index client_credentials_client_id_idx on public.client_credentials (client_id);
