import type { Prediction, PredictionModelInfo } from '@amable/api-types';
import { first, type SqlDb } from '../db/sql';

/**
 * Conversion prediction: one logistic regression per site, trained on the
 * site's own history (one sample per visitor: label = made a purchase; for
 * buyers only the behaviour before the first purchase is used, so the model
 * never learns from what happened because of the purchase). Retrained nightly
 * by the DO alarm. Training is deterministic: zero initial weights, fixed
 * iterations, rows in a stable order.
 */

export const MODEL_VERSION = 1;
export const MAX_TRAINING_VISITORS = 20_000;
export const MIN_SAMPLES = 20;
export const MIN_POSITIVES = 2;
const ITERATIONS = 300;
const LEARNING_RATE = 1;
const L2 = 0.001;
const TOP_COUNTRIES = 12;

export interface VisitorFacts {
  first_channel: string | null;
  device: string | null;
  country: string | null;
  sessions: number;
  pageviews: number;
  duration: number;
  paid: number;
  goals: number;
}

export interface PredictionModel {
  version: number;
  trained_at: number;
  currency: string;
  features: string[];
  weights: number[];
  bias: number;
  countries: string[];
  samples: number;
  positives: number;
  base_rate: number;
  accuracy: number;
  aov_minor: number;
}

function bucket(value: number, edges: readonly number[], labels: readonly string[]): string {
  const i = edges.findIndex((edge) => value <= edge);
  return labels[i === -1 ? labels.length - 1 : i] ?? 'x';
}

/** Categorical features of a visitor (one-hot keys). */
export function featuresOf(f: VisitorFacts, countries: readonly string[]): string[] {
  const country = f.country !== null && countries.includes(f.country) ? f.country : 'other';
  return [
    `channel:${f.first_channel ?? 'unknown'}`,
    `device:${f.device ?? 'unknown'}`,
    `country:${country}`,
    `sessions:${bucket(f.sessions, [1, 2, 4], ['1', '2', '3-4', '5+'])}`,
    `pageviews:${bucket(f.pageviews, [1, 3, 7], ['1', '2-3', '4-7', '8+'])}`,
    `duration:${bucket(f.duration, [30_000, 180_000, 600_000], ['<30s', '30s-3m', '3-10m', '10m+'])}`,
    `goals:${f.goals > 0 ? 'yes' : 'no'}`,
    `paid_traffic:${f.paid > 0 ? 'yes' : 'no'}`,
  ];
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

export interface TrainingSample {
  features: string[];
  label: 0 | 1;
}

/** Batch gradient descent with L2; deterministic for a given sample order. */
export function trainLogistic(samples: readonly TrainingSample[]): {
  features: string[];
  weights: number[];
  bias: number;
  accuracy: number;
} {
  const features = [...new Set(samples.flatMap((s) => s.features))].sort();
  const index = new Map(features.map((f, i) => [f, i]));
  const rows = samples.map((s) => ({
    x: s.features.map((f) => index.get(f) ?? -1).filter((i) => i >= 0),
    y: s.label,
  }));
  const w = new Array<number>(features.length).fill(0);
  let bias = 0;
  const n = rows.length;
  for (let iter = 0; iter < ITERATIONS; iter += 1) {
    const grad = new Array<number>(features.length).fill(0);
    let gradBias = 0;
    for (const row of rows) {
      let z = bias;
      for (const i of row.x) z += w[i] ?? 0;
      const err = sigmoid(z) - row.y;
      gradBias += err;
      for (const i of row.x) grad[i] = (grad[i] ?? 0) + err;
    }
    bias -= (LEARNING_RATE * gradBias) / n;
    for (let i = 0; i < w.length; i += 1) {
      w[i] = (w[i] ?? 0) - LEARNING_RATE * ((grad[i] ?? 0) / n + L2 * (w[i] ?? 0));
    }
  }
  let correct = 0;
  for (const row of rows) {
    let z = bias;
    for (const i of row.x) z += w[i] ?? 0;
    if ((sigmoid(z) >= 0.5 ? 1 : 0) === row.y) correct += 1;
  }
  const round = (v: number): number => Math.round(v * 1e6) / 1e6;
  return {
    features,
    weights: w.map(round),
    bias: round(bias),
    accuracy: n === 0 ? 0 : Math.round((correct / n) * 10_000) / 10_000,
  };
}

/** Probability, 0..100 score (50 = the site's base rate) and expected value. */
export function scoreFacts(model: PredictionModel, facts: VisitorFacts): Prediction {
  const index = new Map(model.features.map((f, i) => [f, i]));
  let z = model.bias;
  for (const f of featuresOf(facts, model.countries)) {
    const i = index.get(f);
    if (i !== undefined) z += model.weights[i] ?? 0;
  }
  const p = sigmoid(z);
  const lift = model.base_rate === 0 ? 0 : p / model.base_rate;
  return {
    score: Math.round((100 * lift) / (lift + 1)),
    conversion_rate: Math.round(p * 10_000) / 10_000,
    expected_value_minor: Math.round(p * model.aov_minor),
  };
}

interface FactsRow extends VisitorFacts {
  id: string;
  purchased_at: number | null;
}

/** Facts of visitors, cut at their first purchase (or `now`). */
function factsQuery(db: SqlDb, visitorIds: readonly string[] | null, now: number): FactsRow[] {
  const scope =
    visitorIds === null
      ? `ORDER BY v.last_seen DESC, v.id LIMIT ${MAX_TRAINING_VISITORS}`
      : `WHERE v.id IN (SELECT value FROM json_each(?))`;
  const params = visitorIds === null ? [] : [JSON.stringify(visitorIds)];
  return db.all<FactsRow>(
    `WITH fp AS (
       SELECT visitor_id, MIN(ts) AS ts FROM payments
       WHERE free_trial = 0 AND visitor_id IS NOT NULL GROUP BY visitor_id
     ),
     vv AS (
       SELECT v.id AS id, v.first_channel AS first_channel, v.device AS device, v.country AS country,
         fp.ts AS purchased_at, v.last_seen AS last_seen
       FROM visitors v LEFT JOIN fp ON fp.visitor_id = v.id ${scope}
     )
     SELECT vv.id AS id, vv.first_channel AS first_channel, vv.device AS device, vv.country AS country,
       vv.purchased_at AS purchased_at, COUNT(s.id) AS sessions, COALESCE(SUM(s.pageviews), 0) AS pageviews,
       COALESCE(SUM(s.duration_ms), 0) AS duration, COALESCE(MAX(s.paid), 0) AS paid,
       (SELECT COUNT(*) FROM goals g WHERE g.visitor_id = vv.id AND g.name NOT IN ('payment', 'free_trial')
          AND g.ts <= COALESCE(vv.purchased_at, ?)) AS goals
     FROM vv LEFT JOIN sessions s ON s.visitor_id = vv.id AND s.started_at <= COALESCE(vv.purchased_at, ?)
     GROUP BY vv.id ORDER BY vv.last_seen DESC, vv.id`,
    ...params,
    now,
    now,
  );
}

export function loadModel(db: SqlDb): PredictionModel | null {
  const row = first<{ model: string }>(db, `SELECT model FROM prediction_model WHERE id = 1`);
  if (row === undefined) return null;
  const model = JSON.parse(row.model) as PredictionModel;
  return model.version === MODEL_VERSION ? model : null;
}

/** Trains (or clears, when there is too little data) the site model. */
export function trainSiteModel(db: SqlDb, currency: string, now: number): PredictionModel | null {
  const rows = factsQuery(db, null, now).filter((r) => r.sessions > 0);
  const positives = rows.filter((r) => r.purchased_at !== null).length;
  if (rows.length < MIN_SAMPLES || positives < MIN_POSITIVES) {
    db.run(`DELETE FROM prediction_model WHERE id = 1`);
    return null;
  }
  const countryCounts = new Map<string, number>();
  for (const r of rows) if (r.country !== null) countryCounts.set(r.country, (countryCounts.get(r.country) ?? 0) + 1);
  const countries = [...countryCounts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_COUNTRIES)
    .map(([c]) => c)
    .sort();
  const trained = trainLogistic(
    rows.map((r) => ({ features: featuresOf(r, countries), label: r.purchased_at === null ? 0 : 1 })),
  );
  const revenue = first<{ total: number | null; buyers: number }>(
    db,
    `SELECT SUM(amount_minor - refunded_minor) AS total, COUNT(DISTINCT visitor_id) AS buyers FROM payments
     WHERE free_trial = 0 AND refunded = 0 AND currency = ? AND visitor_id IS NOT NULL`,
    currency,
  );
  const model: PredictionModel = {
    version: MODEL_VERSION,
    trained_at: now,
    currency,
    ...trained,
    countries,
    samples: rows.length,
    positives,
    base_rate: Math.round((positives / rows.length) * 1e6) / 1e6,
    aov_minor:
      (revenue?.buyers ?? 0) === 0 ? 0 : Math.round((revenue?.total ?? 0) / (revenue?.buyers ?? 1)),
  };
  db.run(
    `INSERT INTO prediction_model (id, trained_at, model) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET trained_at = excluded.trained_at, model = excluded.model`,
    now,
    JSON.stringify(model),
  );
  return model;
}

/** Current predictions of some visitors (behaviour up to now). */
export function predictVisitors(
  db: SqlDb,
  model: PredictionModel | null,
  visitorIds: readonly string[],
  now: number,
): Map<string, Prediction> {
  const out = new Map<string, Prediction>();
  if (model === null || visitorIds.length === 0) return out;
  for (const row of factsQuery(db, visitorIds, now)) {
    // Score the full behaviour, not the pre-purchase cut used for training.
    const live = first<{ sessions: number; pageviews: number | null; duration: number | null; paid: number | null }>(
      db,
      `SELECT COUNT(*) AS sessions, SUM(pageviews) AS pageviews, SUM(duration_ms) AS duration, MAX(paid) AS paid
       FROM sessions WHERE visitor_id = ?`,
      row.id,
    );
    const goals =
      first<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM goals WHERE visitor_id = ? AND name NOT IN ('payment', 'free_trial')`,
        row.id,
      )?.n ?? 0;
    out.set(
      row.id,
      scoreFacts(model, {
        ...row,
        sessions: live?.sessions ?? row.sessions,
        pageviews: live?.pageviews ?? row.pageviews,
        duration: live?.duration ?? row.duration,
        paid: live?.paid ?? row.paid,
        goals,
      }),
    );
  }
  return out;
}

export function modelInfo(model: PredictionModel | null, currency: string): PredictionModelInfo {
  if (model === null) {
    return {
      trained_at: null,
      samples: 0,
      positives: 0,
      base_rate: 0,
      accuracy: null,
      average_order_value_minor: 0,
      currency,
      top_features: [],
    };
  }
  return {
    trained_at: new Date(model.trained_at).toISOString(),
    samples: model.samples,
    positives: model.positives,
    base_rate: model.base_rate,
    accuracy: model.accuracy,
    average_order_value_minor: model.aov_minor,
    currency: model.currency,
    top_features: model.features
      .map((feature, i) => ({ feature, weight: model.weights[i] ?? 0 }))
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || a.feature.localeCompare(b.feature))
      .slice(0, 10),
  };
}
