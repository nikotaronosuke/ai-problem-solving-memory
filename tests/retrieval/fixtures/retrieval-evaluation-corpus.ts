/**
 * The retrieval evaluation corpus: named scenarios, and the deterministic
 * stand-ins that let them be judged offline.
 *
 * This module is **data and pure functions only**. It opens no connection,
 * imports no repository, writes nothing and reaches no network. Seeding it into
 * a database is the integration suite's job, and keeping the two apart is
 * deliberate: a later end-to-end task should be able to reuse these Memories
 * without inheriting a shortcut that seeds a finished state directly.
 *
 * ## What the corpus is for
 *
 * The specification's acceptance for retrieval is not "a search returns
 * something". It is that a Memory from another Project, written in different
 * words about a different technology, is found because the *shape* of the
 * problem matches — and that surface agreement alone does not win. That is a
 * claim about discrimination, and discrimination needs a corpus with wrong
 * answers in it. So every scenario here carries at least one candidate that
 * looks right for the wrong reason.
 *
 * ## The honesty problem, and how it is handled
 *
 * A test double can always be told the answer. A reranker that scored by
 * problem identifier would make every scenario pass while proving nothing at
 * all, because the pipeline would never have had to carry a structural feature
 * anywhere. Two rules keep that from happening:
 *
 * 1. **`FixtureStructuralOracle` sees the structural features and nothing
 *    else.** No identifier, no Project, no rank from an earlier stage, and no
 *    knowledge of which scenario a candidate belongs to. If the features do not
 *    reach it, it cannot score.
 *
 * 2. **The cross-technology pair is paraphrased, not copied.** "configuration
 *    captured during build" and "settings frozen before the runtime starts"
 *    describe one structure in two vocabularies with no word in common. An
 *    oracle matching exact strings would score that pair at zero — which is
 *    precisely the measurement that made the reranker a model port rather than
 *    a set operation in the first place. A baseline assertion in the suite
 *    checks the paraphrasing is real.
 *
 * The oracle is an evaluation instrument, not a proposal. It does not model any
 * vendor's judgement and nothing here should be read as evidence about one.
 */

import type { Confidence, Freshness } from '../../../src/domain/enums.js';
import type { EnvironmentSnapshot } from '../../../src/domain/environment.js';
import type { EmbeddingProvider } from '../../../src/domain/retrieval-embedding.js';
import type {
  StructuralReranker,
  StructuralRerankerInput,
} from '../../../src/domain/retrieval-structural-rerank.js';
import { STRUCTURAL_COMPARISON_DIMENSIONS } from '../../../src/domain/retrieval-structural-rerank.js';
import type { StructuralFeatures } from '../../../src/domain/retrieval-summary.js';

// ---------------------------------------------------------------- embeddings

/**
 * The embedding model the corpus is written for.
 *
 * Three dimensions because the corpus needs three separable subjects and no
 * more; the production side fixes no dimension count, deliberately.
 */
export const EVALUATION_MODEL = {
  id: 'evaluation-embedding-model',
  version: '1',
  dimensions: 3,
} as const;

/**
 * A version this corpus never queries with.
 *
 * One candidate is stored under it on purpose. The vector channel only compares
 * within a model and version — a real rule, not a fixture one — so that
 * candidate is invisible to the semantic side and can only be reached
 * lexically. That is what makes the keyword path load-bearing in a suite where
 * almost everything else has a strong vector signal.
 */
export const LEXICAL_ONLY_MODEL_VERSION = '0';

/**
 * The subjects the corpus talks about.
 *
 * A search query and an artifact are "about" one of these, and that is the only
 * thing the embedding stand-in knows how to express.
 */
export const SEMANTIC_CLASSES = {
  /** Values decided once, at the wrong moment in a lifecycle. */
  CONFIGURATION_LIFECYCLE: [1, 0, 0],
  /** Something finite ran out under load. */
  RESOURCE_POOL_EXHAUSTION: [0, 1, 0],
  /** A credential or session stopped being accepted. */
  AUTH_SESSION_EXPIRY: [0, 0, 1],
  /**
   * Near-neighbour of the first: the same subject described from a different
   * technology's vocabulary. Close enough to be retrieved, far enough that the
   * retrieval is not an identity.
   */
  CONFIGURATION_LIFECYCLE_ADJACENT: [0.94, 0.34, 0],
} as const;

export type SemanticClass = keyof typeof SEMANTIC_CLASSES;

/**
 * An embedding provider that reads the query text and nothing else.
 *
 * It looks for a class marker in the text. It has no access to identifiers,
 * and no table of expected answers — a query about a subject the corpus does
 * not cover gets a vector that is near nothing in particular.
 */
export function createEvaluationEmbeddingProvider(): EmbeddingProvider & {
  readonly calls: number;
} {
  const state = {
    modelId: EVALUATION_MODEL.id,
    modelVersion: EVALUATION_MODEL.version,
    dimensions: EVALUATION_MODEL.dimensions,
    calls: 0,
    embed(input: { readonly text: string }): Promise<readonly number[]> {
      state.calls += 1;
      const text = input.text.toLowerCase();
      for (const [name, vector] of Object.entries(SEMANTIC_CLASSES)) {
        if (text.includes(name.toLowerCase())) {
          return Promise.resolve(vector);
        }
      }
      // Nothing recognised. A non-zero vector pointing away from all three
      // subjects, because a zero vector has no cosine distance at all.
      return Promise.resolve([0.577, 0.577, 0.577]);
    },
  };
  return state;
}

/** Writes a class marker into a query so the provider above can see it. */
export function semanticQuery(semanticClass: SemanticClass, wording: string): string {
  return `${wording} [${semanticClass}]`;
}

// ------------------------------------------------------------ the oracle

/**
 * Phrases that mean the same thing, gathered under one name.
 *
 * A closed table, written for this corpus and no other. Anything absent maps to
 * itself, so two unrelated phrases never match by accident — the table can only
 * ever create agreement it was told about, never invent it.
 *
 * This is the whole of the "semantic" judgement in the suite. It stands where a
 * model would stand and makes no claim to resemble one.
 */
const CONCEPTS: ReadonlyMap<string, string> = new Map([
  // A value fixed at packaging time that should have been read at run time.
  ['configuration captured during build', 'CONFIG_FIXED_TOO_EARLY'],
  ['settings frozen before the runtime starts', 'CONFIG_FIXED_TOO_EARLY'],

  // Correct on a developer machine, wrong once it leaves.
  ['works locally but blank once deployed', 'LOCAL_FINE_REMOTE_BROKEN'],
  ['fine on a developer machine, empty panels once promoted', 'LOCAL_FINE_REMOTE_BROKEN'],

  // Only reproducible away from the machine it was written on.
  ['only in the deployed environment', 'ONLY_AWAY_FROM_DEVELOPMENT'],
  ['only after promotion to a hosted tier', 'ONLY_AWAY_FROM_DEVELOPMENT'],

  // What worked: defer the decision to the moment of use.
  ['read the setting at request time instead of at build time', 'RESOLVE_AT_USE_TIME'],
  [
    'resolve the value when the request arrives rather than when the image is assembled',
    'RESOLVE_AT_USE_TIME',
  ],

  // What did not work: giving the packaging step longer.
  ['raising the build timeout', 'MORE_TIME_FOR_PACKAGING'],
  ['giving the packaging step more time', 'MORE_TIME_FOR_PACKAGING'],

  // Getting something out of the door, under two names.
  ['deployment', 'DELIVERY'],
  ['release', 'DELIVERY'],
]);

/** The concept a phrase belongs to, or the phrase itself when it has none. */
function conceptOf(phrase: string): string {
  return CONCEPTS.get(phrase.trim().toLowerCase()) ?? phrase.trim().toLowerCase();
}

/** The concepts a dimension holds, as a set. */
function conceptsIn(values: readonly string[]): Set<string> {
  return new Set(values.map(conceptOf));
}

/**
 * Whether two sides of one dimension describe a shared concept.
 *
 * Both sides must have material — an empty list agrees with nothing, which is
 * the rule the production output parser enforces anyway, and the reason it does
 * is that an absent record is not a finding.
 */
function dimensionAgrees(
  dimension: (typeof STRUCTURAL_COMPARISON_DIMENSIONS)[number],
  current: StructuralFeatures,
  candidate: StructuralFeatures,
): boolean {
  if (dimension === 'problem_domain') {
    const left = current.problem_domain;
    const right = candidate.problem_domain;
    return left !== null && right !== null && conceptOf(left) === conceptOf(right);
  }

  const left = conceptsIn(current[dimension]);
  const right = conceptsIn(candidate[dimension]);
  if (left.size === 0 || right.size === 0) {
    return false;
  }
  for (const concept of left) {
    if (right.has(concept)) {
      return true;
    }
  }
  return false;
}

/** What the oracle concluded about one candidate, for the suite to inspect. */
export interface OracleJudgement {
  readonly structuralScore: number;
  readonly matchedDimensions: readonly string[];
}

/**
 * Judges one candidate against the current Problem, from features alone.
 *
 * Exported so the suite can state, as an assertion rather than a promise, that
 * the judgement does not move when the identifiers do.
 */
export function judgeStructurally(
  current: StructuralFeatures,
  candidate: StructuralFeatures,
): OracleJudgement {
  const matched = STRUCTURAL_COMPARISON_DIMENSIONS.filter((dimension) =>
    dimensionAgrees(dimension, current, candidate),
  );
  return {
    // Out of the seven the specification names, so a candidate agreeing on
    // everything scores one and the arithmetic stays legible.
    structuralScore: matched.length / STRUCTURAL_COMPARISON_DIMENSIONS.length,
    matchedDimensions: matched,
  };
}

/**
 * A reranker that scores by structure and is told nothing else.
 *
 * The identifier is echoed because the output contract is keyed by it. It is
 * never read on the path that decides a score, and the suite proves that by
 * judging the same features twice under different identifiers.
 */
export function createFixtureStructuralOracle(): StructuralReranker & {
  readonly calls: number;
  readonly seen: StructuralRerankerInput[];
} {
  const state = {
    calls: 0,
    seen: [] as StructuralRerankerInput[],
    rerank(input: StructuralRerankerInput): Promise<unknown> {
      state.calls += 1;
      state.seen.push(input);
      return Promise.resolve({
        candidates: input.candidates.map((candidate) => {
          const judgement = judgeStructurally(input.current, candidate.features);
          return {
            problemId: candidate.problemId,
            structuralScore: judgement.structuralScore,
            matchedDimensions: judgement.matchedDimensions,
          };
        }),
      });
    },
  };
  return state;
}

// ------------------------------------------------------------------ the corpus

/** How a Memory is written down before anything is seeded. */
export interface CorpusMemory {
  /** Stable, human-readable, and never a database identifier. */
  readonly role: string;
  readonly projectRole: string;
  readonly symptoms: string;
  readonly problemDomain: string;
  readonly suspectedBoundary: string;
  readonly environment: EnvironmentSnapshot;
  /** Absent for a Memory that exists only to be pointed at by a Relation. */
  readonly artifact?: {
    readonly normalizedSummary: string;
    readonly keywords: readonly string[];
    readonly semanticClass: SemanticClass;
    readonly features: StructuralFeatures;
    /** Set only for the candidate the semantic channel must not see. */
    readonly modelVersion?: string;
  };
  readonly confidence?: Confidence;
  readonly freshness?: Freshness;
  readonly suppressed?: boolean;
}

/** A Project, named by role rather than by identifier. */
export interface CorpusProject {
  readonly role: string;
  readonly platform: string;
}

const REACT = 'react';
const DJANGO = 'django';
const FASTIFY = 'fastify';
const RAILS = 'rails';

export const CORPUS_PROJECTS: readonly CorpusProject[] = [
  { role: 'delivery-current', platform: REACT },
  { role: 'delivery-same-tech', platform: REACT },
  { role: 'delivery-cross-tech', platform: DJANGO },
  { role: 'delivery-surface', platform: REACT },
  { role: 'controls-current', platform: FASTIFY },
  { role: 'controls-candidates', platform: FASTIFY },
  { role: 'enrichment-current', platform: RAILS },
  { role: 'enrichment-candidates', platform: RAILS },
];

/** The Project a foreign owner's decoy lives in. */
export const FOREIGN_PROJECT: CorpusProject = { role: 'foreign', platform: REACT };

const DELIVERY_ENVIRONMENT: EnvironmentSnapshot = {
  runtime: 'node 20.11.0',
  framework: 'react 18.2.0',
  deployment: 'container image',
};

const CROSS_TECH_ENVIRONMENT: EnvironmentSnapshot = {
  runtime: 'python 3.11.6',
  framework: 'django 4.2.0',
  deployment: 'platform buildpack',
};

/**
 * The Problem being worked on when the delivery scenarios run.
 *
 * It has a findable artifact of its own, and a strong one. A search must not
 * offer somebody the Problem they are already looking at, and the only way to
 * show that convincingly is to make it the best match in the corpus.
 */
export const DELIVERY_CURRENT: CorpusMemory = {
  role: 'delivery-current',
  projectRole: 'delivery-current',
  symptoms: 'the checkout widget renders blank after deployment',
  problemDomain: 'deployment',
  suspectedBoundary: 'configuration captured during build',
  environment: DELIVERY_ENVIRONMENT,
  artifact: {
    normalizedSummary: 'the checkout widget renders blank after deployment',
    keywords: ['checkout', 'widget', 'blank', 'deployment'],
    semanticClass: 'CONFIGURATION_LIFECYCLE',
    features: {
      schema_version: '1',
      problem_domain: 'deployment',
      symptom_patterns: ['works locally but blank once deployed'],
      suspected_boundaries: ['configuration captured during build'],
      occurrence_conditions: ['only in the deployed environment'],
      successful_directions: ['read the setting at request time instead of at build time'],
      dead_end_directions: ['raising the build timeout'],
      environment_facts: ['react 18.2.0'],
    },
  },
};

/** The structural profile the delivery scenarios search with. */
export const DELIVERY_QUERY_FEATURES: StructuralFeatures = {
  schema_version: '1',
  problem_domain: 'deployment',
  symptom_patterns: ['works locally but blank once deployed'],
  suspected_boundaries: ['configuration captured during build'],
  occurrence_conditions: ['only in the deployed environment'],
  successful_directions: ['read the setting at request time instead of at build time'],
  dead_end_directions: ['raising the build timeout'],
  environment_facts: ['react 18.2.0'],
};

/** The words the delivery scenarios search with, and their subject. */
export const DELIVERY_QUERY = {
  lexical: 'checkout widget renders blank after deployment',
  semantic: semanticQuery('CONFIGURATION_LIFECYCLE', 'a page that goes blank once it is deployed'),
} as const;

/**
 * Same technology, same symptom, another Project.
 *
 * Written in the query's own words — that is what "same symptom" means in a
 * corpus, and it is why this one is reachable by keyword. Its artifact is
 * stored under a model version the search never uses, so the semantic channel
 * cannot see it at all: if the keyword path stops working, this candidate
 * disappears.
 */
export const SAME_TECH_MEMORY: CorpusMemory = {
  role: 'same-tech-same-symptom',
  projectRole: 'delivery-same-tech',
  symptoms: 'the checkout widget renders blank after deployment on the staging tier',
  problemDomain: 'deployment',
  suspectedBoundary: 'configuration captured during build',
  environment: DELIVERY_ENVIRONMENT,
  artifact: {
    normalizedSummary: 'the checkout widget renders blank after deployment on the staging tier',
    keywords: ['checkout', 'widget', 'blank', 'deployment'],
    semanticClass: 'CONFIGURATION_LIFECYCLE',
    modelVersion: LEXICAL_ONLY_MODEL_VERSION,
    features: {
      schema_version: '1',
      problem_domain: 'deployment',
      symptom_patterns: ['works locally but blank once deployed'],
      suspected_boundaries: ['configuration captured during build'],
      occurrence_conditions: ['only in the deployed environment'],
      successful_directions: ['read the setting at request time instead of at build time'],
      dead_end_directions: ['raising the build timeout'],
      environment_facts: ['react 18.2.0'],
    },
  },
};

/**
 * A different technology, the same problem, and not one word in common.
 *
 * This is the corpus's central case. Nothing in its summary or keywords appears
 * in the query, so the keyword channel cannot reach it; its subject is adjacent
 * to the query's, so the semantic channel can. And every structural phrase is a
 * paraphrase rather than a copy — an exact-string comparison scores this pair
 * at nothing, which is the measurement that made structural judgement a model
 * port instead of a set intersection.
 */
export const CROSS_TECH_MEMORY: CorpusMemory = {
  role: 'cross-tech-structural',
  projectRole: 'delivery-cross-tech',
  symptoms: 'the administrative dashboard shows empty panels once a release is promoted',
  problemDomain: 'release',
  suspectedBoundary: 'settings frozen before the runtime starts',
  environment: CROSS_TECH_ENVIRONMENT,
  artifact: {
    normalizedSummary:
      'the administrative dashboard shows empty panels once a release is promoted to a hosted tier',
    keywords: ['dashboard', 'panels', 'release', 'promotion'],
    semanticClass: 'CONFIGURATION_LIFECYCLE_ADJACENT',
    features: {
      schema_version: '1',
      problem_domain: 'release',
      symptom_patterns: ['fine on a developer machine, empty panels once promoted'],
      suspected_boundaries: ['settings frozen before the runtime starts'],
      occurrence_conditions: ['only after promotion to a hosted tier'],
      successful_directions: [
        'resolve the value when the request arrives rather than when the image is assembled',
      ],
      dead_end_directions: ['giving the packaging step more time'],
      environment_facts: ['django 4.2.0'],
    },
  },
};

/**
 * The same words, a different cause.
 *
 * Its summary and keywords are the query's, and its subject is the query's, so
 * both retrieval channels rank it highly. What differs is everything that
 * explains the problem: where the fault was, when it showed, what fixed it and
 * what did not. It is not expected to vanish — a candidate is a candidate — but
 * it must not outrank the Memory that actually matches.
 */
export const SURFACE_DECOY_MEMORY: CorpusMemory = {
  role: 'surface-similar-different-cause',
  projectRole: 'delivery-surface',
  symptoms: 'the checkout widget renders blank after deployment',
  problemDomain: 'deployment',
  suspectedBoundary: 'the content delivery cache serves an old bundle',
  environment: DELIVERY_ENVIRONMENT,
  artifact: {
    normalizedSummary: 'the checkout widget renders blank after deployment for returning visitors',
    keywords: ['checkout', 'widget', 'blank', 'deployment'],
    semanticClass: 'CONFIGURATION_LIFECYCLE',
    features: {
      schema_version: '1',
      problem_domain: 'deployment',
      symptom_patterns: ['works locally but blank once deployed'],
      suspected_boundaries: ['the content delivery cache serves an old bundle'],
      occurrence_conditions: ['only for visitors who loaded the page earlier that day'],
      successful_directions: ['add a fingerprint to the asset file name'],
      dead_end_directions: ['clearing the browser cache by hand'],
      environment_facts: ['react 18.2.0'],
    },
  },
};

// ------------------------------------------------- ranking controls and bound

const POOL_ENVIRONMENT: EnvironmentSnapshot = {
  runtime: 'node 22.12.0',
  database: 'postgresql 17.6',
};

/** The structural profile the controls scenarios search with. */
export const CONTROLS_QUERY_FEATURES: StructuralFeatures = {
  schema_version: '1',
  problem_domain: 'persistence',
  symptom_patterns: ['requests hang until they time out under load'],
  suspected_boundaries: ['the database connection pool is exhausted'],
  occurrence_conditions: ['only above roughly two hundred concurrent requests'],
  successful_directions: ['release the connection before the slow call'],
  dead_end_directions: ['raising the pool size alone'],
  environment_facts: ['postgresql 17.6'],
};

export const CONTROLS_QUERY = {
  lexical: 'requests hang until they time out under load',
  semantic: semanticQuery('RESOURCE_POOL_EXHAUSTION', 'connections running out when traffic rises'),
} as const;

export const CONTROLS_CURRENT: CorpusMemory = {
  role: 'controls-current',
  projectRole: 'controls-current',
  symptoms: 'requests hang until they time out under load',
  problemDomain: 'persistence',
  suspectedBoundary: 'the database connection pool is exhausted',
  environment: POOL_ENVIRONMENT,
};

/**
 * Seven candidates whose structural strength runs the opposite way to the
 * order they should be offered in.
 *
 * That inversion is the whole design. The strongest structural match is the one
 * somebody suppressed; the weakest of the five survivors is the one the record
 * calls current and trusted. So a pipeline that quietly stopped consulting
 * suppression, currency or trust would produce almost exactly the reverse of
 * what is asserted, rather than something subtly different.
 *
 * The two that never reach the ranking stage are trusted and current — they are
 * cut by the rerank ceiling, not by any control, which is what makes the bound
 * observable as its own fact.
 */
export const CONTROLS_CANDIDATES: readonly CorpusMemory[] = [
  // Seven dimensions agree: the strongest structural match in the corpus.
  {
    role: 'controls-suppressed',
    projectRole: 'controls-candidates',
    symptoms: 'requests hang until they time out under load',
    problemDomain: 'persistence',
    suspectedBoundary: 'the database connection pool is exhausted',
    environment: POOL_ENVIRONMENT,
    suppressed: true,
    confidence: 'HIGH',
    artifact: {
      normalizedSummary: 'requests hang until they time out under load, and were set aside',
      keywords: ['requests', 'hang', 'load'],
      semanticClass: 'RESOURCE_POOL_EXHAUSTION',
      features: {
        schema_version: '1',
        problem_domain: 'persistence',
        symptom_patterns: ['requests hang until they time out under load'],
        suspected_boundaries: ['the database connection pool is exhausted'],
        occurrence_conditions: ['only above roughly two hundred concurrent requests'],
        successful_directions: ['release the connection before the slow call'],
        dead_end_directions: ['raising the pool size alone'],
        environment_facts: ['postgresql 17.6'],
      },
    },
  },
  // Six agree; the record says nobody has checked it lately.
  {
    role: 'controls-stale',
    projectRole: 'controls-candidates',
    symptoms: 'requests hang until they time out under load',
    problemDomain: 'persistence',
    suspectedBoundary: 'the database connection pool is exhausted',
    environment: POOL_ENVIRONMENT,
    freshness: 'STALE_UNKNOWN',
    confidence: 'HIGH',
    artifact: {
      normalizedSummary: 'requests hang until they time out under load, unchecked since',
      keywords: ['requests', 'hang', 'load'],
      semanticClass: 'RESOURCE_POOL_EXHAUSTION',
      features: {
        schema_version: '1',
        problem_domain: 'persistence',
        symptom_patterns: ['requests hang until they time out under load'],
        suspected_boundaries: ['the database connection pool is exhausted'],
        occurrence_conditions: ['only above roughly two hundred concurrent requests'],
        successful_directions: ['release the connection before the slow call'],
        dead_end_directions: ['raising the pool size alone'],
        environment_facts: ['a different database entirely'],
      },
    },
  },
  // Five agree; the record's own confidence in it is low.
  {
    role: 'controls-low',
    projectRole: 'controls-candidates',
    symptoms: 'requests hang until they time out under load',
    problemDomain: 'persistence',
    suspectedBoundary: 'the database connection pool is exhausted',
    environment: POOL_ENVIRONMENT,
    confidence: 'LOW',
    artifact: {
      normalizedSummary: 'requests hang until they time out under load, barely investigated',
      keywords: ['requests', 'hang', 'load'],
      semanticClass: 'RESOURCE_POOL_EXHAUSTION',
      features: {
        schema_version: '1',
        problem_domain: 'persistence',
        symptom_patterns: ['requests hang until they time out under load'],
        suspected_boundaries: ['the database connection pool is exhausted'],
        occurrence_conditions: ['only above roughly two hundred concurrent requests'],
        successful_directions: ['release the connection before the slow call'],
        dead_end_directions: ['an unrelated dead end'],
        environment_facts: ['a different database entirely'],
      },
    },
  },
  // Four agree; middling trust.
  {
    role: 'controls-medium',
    projectRole: 'controls-candidates',
    symptoms: 'requests hang until they time out under load',
    problemDomain: 'persistence',
    suspectedBoundary: 'the database connection pool is exhausted',
    environment: POOL_ENVIRONMENT,
    confidence: 'MEDIUM',
    artifact: {
      normalizedSummary: 'requests hang until they time out under load, partly understood',
      keywords: ['requests', 'hang', 'load'],
      semanticClass: 'RESOURCE_POOL_EXHAUSTION',
      features: {
        schema_version: '1',
        problem_domain: 'persistence',
        symptom_patterns: ['requests hang until they time out under load'],
        suspected_boundaries: ['the database connection pool is exhausted'],
        occurrence_conditions: ['only above roughly two hundred concurrent requests'],
        successful_directions: ['an unrelated direction'],
        dead_end_directions: ['an unrelated dead end'],
        environment_facts: ['a different database entirely'],
      },
    },
  },
  // Three agree, and it is the one that should be offered first.
  {
    role: 'controls-trusted',
    projectRole: 'controls-candidates',
    symptoms: 'requests hang until they time out under load',
    problemDomain: 'persistence',
    suspectedBoundary: 'the database connection pool is exhausted',
    environment: POOL_ENVIRONMENT,
    confidence: 'HIGH',
    artifact: {
      normalizedSummary: 'requests hang until they time out under load, confirmed and current',
      keywords: ['requests', 'hang', 'load'],
      semanticClass: 'RESOURCE_POOL_EXHAUSTION',
      features: {
        schema_version: '1',
        problem_domain: 'persistence',
        symptom_patterns: ['requests hang until they time out under load'],
        suspected_boundaries: ['the database connection pool is exhausted'],
        occurrence_conditions: ['an unrelated condition'],
        successful_directions: ['an unrelated direction'],
        dead_end_directions: ['an unrelated dead end'],
        environment_facts: ['a different database entirely'],
      },
    },
  },
  // Two agree. Trusted and current, and still cut by the ceiling.
  {
    role: 'controls-beyond-bound-first',
    projectRole: 'controls-candidates',
    symptoms: 'requests hang until they time out under load',
    problemDomain: 'persistence',
    suspectedBoundary: 'the database connection pool is exhausted',
    environment: POOL_ENVIRONMENT,
    confidence: 'HIGH',
    artifact: {
      normalizedSummary: 'requests hang until they time out under load, sixth by structure',
      keywords: ['requests', 'hang', 'load'],
      semanticClass: 'RESOURCE_POOL_EXHAUSTION',
      features: {
        schema_version: '1',
        problem_domain: 'persistence',
        symptom_patterns: ['requests hang until they time out under load'],
        suspected_boundaries: ['an unrelated boundary'],
        occurrence_conditions: ['an unrelated condition'],
        successful_directions: ['an unrelated direction'],
        dead_end_directions: ['an unrelated dead end'],
        environment_facts: ['a different database entirely'],
      },
    },
  },
  // One agrees. Trusted and current, and cut for the same reason.
  {
    role: 'controls-beyond-bound-second',
    projectRole: 'controls-candidates',
    symptoms: 'requests hang until they time out under load',
    problemDomain: 'persistence',
    suspectedBoundary: 'an unrelated boundary',
    environment: POOL_ENVIRONMENT,
    confidence: 'HIGH',
    artifact: {
      normalizedSummary: 'requests hang until they time out under load, seventh by structure',
      keywords: ['requests', 'hang', 'load'],
      semanticClass: 'RESOURCE_POOL_EXHAUSTION',
      features: {
        schema_version: '1',
        problem_domain: 'persistence',
        symptom_patterns: ['an unrelated symptom'],
        suspected_boundaries: ['an unrelated boundary'],
        occurrence_conditions: ['an unrelated condition'],
        successful_directions: ['an unrelated direction'],
        dead_end_directions: ['an unrelated dead end'],
        environment_facts: ['a different database entirely'],
      },
    },
  },
];

/** Offered order for the five that survive: the reverse of structural strength. */
export const CONTROLS_EXPECTED_ORDER: readonly string[] = [
  'controls-trusted',
  'controls-medium',
  'controls-low',
  'controls-stale',
  'controls-suppressed',
];

/** The two the rerank ceiling removes, despite both being trusted and current. */
export const CONTROLS_BEYOND_BOUND: readonly string[] = [
  'controls-beyond-bound-first',
  'controls-beyond-bound-second',
];

// ---------------------------------------------------- dead ends and conflicts

const SESSION_ENVIRONMENT: EnvironmentSnapshot = {
  runtime: 'ruby 3.3.0',
  framework: 'rails 7.1.0',
  identity: 'oauth2 authorisation code',
};

/** Materially different conditions, so a conflict has something to compare. */
const COUNTERPART_ENVIRONMENT: EnvironmentSnapshot = {
  runtime: 'ruby 3.1.4',
  framework: 'rails 6.1.7',
  identity: 'session cookie',
};

export const ENRICHMENT_QUERY_FEATURES: StructuralFeatures = {
  schema_version: '1',
  problem_domain: 'authentication',
  symptom_patterns: ['users are signed out part way through a long form'],
  suspected_boundaries: ['the access token expires before the form is submitted'],
  occurrence_conditions: ['only when the form is open for more than an hour'],
  successful_directions: ['refresh the token in the background while the form is open'],
  dead_end_directions: ['extending the token lifetime for everybody'],
  environment_facts: ['rails 7.1.0'],
};

export const ENRICHMENT_QUERY = {
  lexical: 'users are signed out part way through a long form',
  semantic: semanticQuery('AUTH_SESSION_EXPIRY', 'being signed out while still working'),
} as const;

export const ENRICHMENT_CURRENT: CorpusMemory = {
  role: 'enrichment-current',
  projectRole: 'enrichment-current',
  symptoms: 'users are signed out part way through a long form',
  problemDomain: 'authentication',
  suspectedBoundary: 'the access token expires before the form is submitted',
  environment: SESSION_ENVIRONMENT,
};

/** A Memory with directions already known not to work. */
export const DEAD_END_MEMORY: CorpusMemory = {
  role: 'dead-end-memory',
  projectRole: 'enrichment-candidates',
  symptoms: 'users are signed out part way through a long form',
  problemDomain: 'authentication',
  suspectedBoundary: 'the access token expires before the form is submitted',
  environment: SESSION_ENVIRONMENT,
  confidence: 'HIGH',
  artifact: {
    normalizedSummary: 'users are signed out part way through a long form',
    keywords: ['signed', 'out', 'form'],
    semanticClass: 'AUTH_SESSION_EXPIRY',
    features: {
      schema_version: '1',
      problem_domain: 'authentication',
      symptom_patterns: ['users are signed out part way through a long form'],
      suspected_boundaries: ['the access token expires before the form is submitted'],
      occurrence_conditions: ['only when the form is open for more than an hour'],
      successful_directions: ['refresh the token in the background while the form is open'],
      // A generator's paraphrase, kept for structural comparison. What the
      // Events below actually say is different, and both are supposed to be.
      dead_end_directions: ['extending the token lifetime for everybody'],
      environment_facts: ['rails 7.1.0'],
    },
  },
};

/**
 * What was recorded as a dead end, in the words somebody used at the time.
 *
 * Deliberately not the artifact's phrasing. The artifact carries a regenerable
 * rendering for comparing shapes; a warning is a claim about something that
 * happened, and it comes from the Event that recorded it happening.
 */
export const DEAD_END_EVENTS: readonly {
  readonly summary: string;
  readonly result: string | null;
  readonly reason: string | null;
}[] = [
  {
    summary: 'raised the access token lifetime to twenty-four hours for every client',
    result: 'the sign-outs stopped, and a stolen token stayed usable for a day',
    reason: 'the exposure was worse than the problem it solved',
  },
  {
    summary: 'kept the form state in local storage and re-authenticated on submit',
    result: 'the submission still failed when the refresh itself had expired',
    reason: 'it moved the expiry rather than handling it',
  },
];

/** A Memory another Memory was recorded as contradicting. */
export const CONFLICTED_MEMORY: CorpusMemory = {
  role: 'conflicted-memory',
  projectRole: 'enrichment-candidates',
  symptoms: 'users are signed out part way through a long form on the hosted tier',
  problemDomain: 'authentication',
  suspectedBoundary: 'the access token expires before the form is submitted',
  environment: SESSION_ENVIRONMENT,
  confidence: 'HIGH',
  artifact: {
    normalizedSummary: 'users are signed out part way through a long form on the hosted tier',
    keywords: ['signed', 'out', 'form'],
    semanticClass: 'AUTH_SESSION_EXPIRY',
    features: {
      schema_version: '1',
      problem_domain: 'authentication',
      symptom_patterns: ['users are signed out part way through a long form'],
      suspected_boundaries: ['the access token expires before the form is submitted'],
      occurrence_conditions: ['only when the form is open for more than an hour'],
      successful_directions: ['refresh the token in the background while the form is open'],
      dead_end_directions: ['extending the token lifetime for everybody'],
      environment_facts: ['rails 7.1.0'],
    },
  },
};

/**
 * The other side of the disagreement.
 *
 * No artifact: it is reached through the Relation, not through a search, and
 * giving it one would make it compete as a candidate in its own right. Its
 * conditions, symptoms and evidence all differ from the Memory it contradicts,
 * which is what leaves a caller something to compare.
 */
export const CONFLICT_COUNTERPART: CorpusMemory = {
  role: 'conflict-counterpart',
  projectRole: 'enrichment-candidates',
  symptoms: 'the sign-out happens immediately on the very first submission attempt',
  problemDomain: 'authentication',
  suspectedBoundary: 'the session cookie is dropped by the proxy',
  environment: COUNTERPART_ENVIRONMENT,
  confidence: 'MEDIUM',
  freshness: 'STALE_UNKNOWN',
};

/** Why somebody linked the two, in their own words. */
export const CONFLICT_REASON =
  'one concluded the token expiry was at fault, the other that the proxy dropped the cookie';

/** What was checked on each side of the disagreement, and whether it held. */
export const CONFLICTED_VERIFICATIONS: readonly {
  readonly result: boolean;
  readonly summary: string;
}[] = [{ result: true, summary: 'reproduced with a token that expired mid-form' }];

export const COUNTERPART_VERIFICATIONS: readonly {
  readonly result: boolean;
  readonly summary: string;
}[] = [
  { result: false, summary: 'the token was still valid when the sign-out happened' },
  { result: true, summary: 'the proxy stripped the cookie on the first hop' },
];

/**
 * Another owner's Memory, written to match the delivery query perfectly.
 *
 * Same words, same subject, same structure. It is the strongest match in the
 * corpus for that query and must never appear, because a boundary that only
 * holds against weak matches is not a boundary.
 */
export const FOREIGN_DECOY: CorpusMemory = {
  role: 'foreign-decoy',
  projectRole: 'foreign',
  symptoms: 'the checkout widget renders blank after deployment',
  problemDomain: 'deployment',
  suspectedBoundary: 'configuration captured during build',
  environment: DELIVERY_ENVIRONMENT,
  artifact: {
    normalizedSummary: 'the checkout widget renders blank after deployment',
    keywords: ['checkout', 'widget', 'blank', 'deployment'],
    semanticClass: 'CONFIGURATION_LIFECYCLE',
    features: {
      schema_version: '1',
      problem_domain: 'deployment',
      symptom_patterns: ['works locally but blank once deployed'],
      suspected_boundaries: ['configuration captured during build'],
      occurrence_conditions: ['only in the deployed environment'],
      successful_directions: ['read the setting at request time instead of at build time'],
      dead_end_directions: ['raising the build timeout'],
      environment_facts: ['react 18.2.0'],
    },
  },
};

/** Every Memory this owner's corpus holds, in seeding order. */
export const CORPUS_MEMORIES: readonly CorpusMemory[] = [
  DELIVERY_CURRENT,
  SAME_TECH_MEMORY,
  CROSS_TECH_MEMORY,
  SURFACE_DECOY_MEMORY,
  CONTROLS_CURRENT,
  ...CONTROLS_CANDIDATES,
  ENRICHMENT_CURRENT,
  DEAD_END_MEMORY,
  CONFLICTED_MEMORY,
  CONFLICT_COUNTERPART,
];
