-- P5-04c2a: where an owner's repository boundary is kept.
--
-- A repository may hold several Projects: `apps/web` and `apps/api` are
-- separate long-lived units of work in one checkout. Which of those splits
-- exist is the owner's decision and nothing a filesystem can answer — but
-- until now there was nowhere to keep the answer, so every session in a split
-- repository asked again.
--
-- Null means no subdirectory boundary: the project stands for the repository
-- as a whole. Every existing row takes null, which is exactly what those rows
-- already meant.
--
-- Deliberately not unique, in any combination. Two projects declaring the same
-- boundary is a real situation — a duplicate the owner will want to merge —
-- and it has to be *observable* as an ambiguity rather than made impossible by
-- storage. A repository holding several projects is the whole point of the
-- column, so uniqueness on `repo` would contradict the feature it belongs to.
alter table public.projects
  add column repo_subpath text;

-- The application validates this too. The constraint is here because the
-- column is identity material rather than a label: a value that is nearly
-- right — a leading slash, a trailing slash, a Windows separator — is a
-- boundary that silently fails to match the sessions it was meant to cover,
-- and a stored one would be wrong for as long as nobody looked.
--
-- Written without a single backslash escape. The obvious spelling of "contains
-- no backslash" is a regex, and a regex needs an escaped backslash, whose
-- meaning depends on how the string literal was read — the first version of
-- this constraint compiled to an invalid pattern and refused every value,
-- including the valid ones. `chr(92)` and a segment split say the same thing
-- and cannot be read two ways.
--
-- What it refuses: empty, a leading or trailing `/`, any backslash, an empty
-- segment, and a `.` or `..` segment. Ordinary characters are not policed —
-- a directory called `a b` is a directory somebody has.
alter table public.projects
  add constraint projects_repo_subpath_relative check (
    repo_subpath is null
    or (
      repo_subpath <> ''
      and strpos(repo_subpath, chr(92)) = 0
      and left(repo_subpath, 1) <> '/'
      and right(repo_subpath, 1) <> '/'
      and strpos(repo_subpath, '//') = 0
      and not ('.' = any (string_to_array(repo_subpath, '/')))
      and not ('..' = any (string_to_array(repo_subpath, '/')))
    )
  );

comment on column public.projects.repo_subpath is
  'Owner-declared repository-relative project boundary, POSIX-separated. Null means no subdirectory boundary: the project covers the repository as a whole. Never an absolute or machine-local path.';
