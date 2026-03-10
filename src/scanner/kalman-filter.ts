import { createChildLogger } from '../logger.js';

const log = createChildLogger('kalman');

/**
 * Kalman Filter for online hedge ratio (beta) estimation.
 *
 * Models: spread_t = alpha + beta_t * price_B_t + noise
 * State: [alpha, beta] — updated each observation via Kalman recursion.
 *
 * Advantages over static OLS:
 * - Adapts to regime changes (time-varying beta)
 * - No lookback window needed — uses all history incrementally
 * - Smooth transition between regimes
 */
export interface KalmanState {
  /** Current estimated [alpha, beta] */
  beta: number;
  alpha: number;
  /** 2x2 covariance matrix P (flattened [P00, P01, P10, P11]) */
  P: [number, number, number, number];
  /** Measurement noise variance R */
  R: number;
  /** Process noise variance Q (controls adaptation speed) */
  Q: number;
  /** Number of observations processed */
  n: number;
}

/**
 * Initialize a Kalman filter state.
 * @param delta - Process noise / adaptation speed (higher = faster adaptation, noisier)
 *   Recommended: 1e-4 to 1e-2. Default 1e-4 is conservative (stable beta).
 * @param ve - Initial measurement noise estimate (observation variance)
 */
export function initKalman(delta: number = 1e-4, ve: number = 1e-3): KalmanState {
  return {
    beta: 0,
    alpha: 0,
    // Start with large uncertainty
    P: [1, 0, 0, 1],
    R: ve,
    Q: delta,
    n: 0,
  };
}

/**
 * Update Kalman filter with a new observation pair.
 * @param state - Current Kalman state (mutated in place for performance)
 * @param priceA - log price of asset A (dependent variable)
 * @param priceB - log price of asset B (independent variable)
 * @returns Updated state with new beta estimate
 */
export function kalmanUpdate(state: KalmanState, priceA: number, priceB: number): KalmanState {
  // Observation model: priceA = alpha + beta * priceB + noise
  // State vector x = [alpha, beta], observation matrix F = [1, priceB]
  const F0 = 1;      // for alpha
  const F1 = priceB;  // for beta

  // Prediction step: P = P + Q*I
  const P00 = state.P[0] + state.Q;
  const P01 = state.P[1];
  const P10 = state.P[2];
  const P11 = state.P[3] + state.Q;

  // Innovation: y = priceA - F'*x
  const yHat = state.alpha * F0 + state.beta * F1;
  const innovation = priceA - yHat;

  // Innovation covariance: S = F'*P*F + R
  const S = F0 * (P00 * F0 + P01 * F1) + F1 * (P10 * F0 + P11 * F1) + state.R;

  if (Math.abs(S) < 1e-20) {
    state.n++;
    return state;
  }

  // Kalman gain: K = P*F / S
  const K0 = (P00 * F0 + P01 * F1) / S;
  const K1 = (P10 * F0 + P11 * F1) / S;

  // State update: x = x + K * innovation
  state.alpha += K0 * innovation;
  state.beta += K1 * innovation;

  // Covariance update: P = P - K * F' * P (Joseph form for stability)
  state.P[0] = P00 - K0 * (F0 * P00 + F1 * P10);
  state.P[1] = P01 - K0 * (F0 * P01 + F1 * P11);
  state.P[2] = P10 - K1 * (F0 * P00 + F1 * P10);
  state.P[3] = P11 - K1 * (F0 * P01 + F1 * P11);

  // Update measurement noise (exponential moving average of squared innovations)
  if (state.n > 1) {
    const decay = 0.97;
    state.R = decay * state.R + (1 - decay) * innovation * innovation;
  }

  state.n++;
  return state;
}

/**
 * Train Kalman filter on historical price arrays.
 * Processes all data points and returns the final state with estimated beta.
 */
export function trainKalman(
  pricesA: number[],
  pricesB: number[],
  delta: number = 1e-4,
): KalmanState {
  const n = Math.min(pricesA.length, pricesB.length);
  const state = initKalman(delta);

  for (let i = 0; i < n; i++) {
    const logA = Math.log(pricesA[i]);
    const logB = Math.log(pricesB[i]);
    kalmanUpdate(state, logA, logB);
  }

  log.debug({
    n,
    beta: state.beta.toFixed(6),
    alpha: state.alpha.toFixed(6),
    R: state.R.toExponential(3),
  }, 'Kalman filter trained');

  return state;
}

/**
 * Calculate spread and Z-score using Kalman filter beta.
 * spread = log(A) - beta * log(B)
 * Z-score computed over a rolling window of recent spreads.
 */
export function kalmanZScore(
  pricesA: number[],
  pricesB: number[],
  kalmanState: KalmanState,
  window: number = 120,
): { zScore: number; spread: number; beta: number; mean: number; std: number } {
  const n = Math.min(pricesA.length, pricesB.length);
  const beta = kalmanState.beta;

  // Calculate spreads for the window
  const startIdx = Math.max(0, n - window);
  const spreads: number[] = [];
  for (let i = startIdx; i < n; i++) {
    spreads.push(Math.log(pricesA[i]) - beta * Math.log(pricesB[i]));
  }

  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const variance = spreads.reduce((a, b) => a + (b - mean) ** 2, 0) / spreads.length;
  const std = Math.sqrt(variance);

  const currentSpread = spreads[spreads.length - 1];
  const zScore = std > 0 ? (currentSpread - mean) / std : 0;

  return { zScore, spread: currentSpread, beta, mean, std };
}

/**
 * Serialize Kalman state for DB storage (JSON-safe).
 */
export function serializeKalman(state: KalmanState): string {
  return JSON.stringify({
    beta: state.beta,
    alpha: state.alpha,
    P: state.P,
    R: state.R,
    Q: state.Q,
    n: state.n,
  });
}

/**
 * Deserialize Kalman state from DB storage.
 */
export function deserializeKalman(json: string): KalmanState | null {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed.beta !== 'number') return null;
    return {
      beta: parsed.beta,
      alpha: parsed.alpha,
      P: parsed.P,
      R: parsed.R,
      Q: parsed.Q,
      n: parsed.n,
    };
  } catch {
    return null;
  }
}
