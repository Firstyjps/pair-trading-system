export type PositionState = 'PENDING' | 'LEG_A_OPEN' | 'BOTH_LEGS_OPEN' | 'CLOSING' | 'CLOSED' | 'ERROR';
export type Direction = 'SHORT_SPREAD' | 'LONG_SPREAD';
export type LegSide = 'buy' | 'sell';
export type CloseReason = 'TP' | 'SL' | 'MANUAL' | 'ORPHAN' | 'ERROR';

export interface PairPosition {
  id: string;
  pair: string;
  direction: Direction;
  state: PositionState;
  leg_a_symbol: string;
  leg_a_side: LegSide;
  leg_a_size: number;
  leg_a_entry_price: number | null;
  leg_a_order_id: string | null;
  leg_b_symbol: string;
  leg_b_side: LegSide;
  leg_b_size: number;
  leg_b_entry_price: number | null;
  leg_b_order_id: string | null;
  entry_z_score: number;
  entry_spread: number;
  current_z_score: number | null;
  stop_loss_z: number;
  take_profit_z: number;
  leverage: number;
  margin_per_leg: number;
  pnl: number | null;
  signal_id: string;
  group_id: string;
  opened_at: string;
  closed_at: string | null;
  close_reason: CloseReason | null;
  metadata: string | null;
}

export interface Signal {
  id: string;
  pair: string;
  direction: Direction;
  z_score: number;
  spread: number;
  correlation: number;
  cointegration_pvalue: number;
  half_life: number;
  created_at: string;
  acted_on: boolean;
}

export interface ZScoreRecord {
  id: number;
  pair: string;
  z_score: number;
  spread: number;
  price_a: number;
  price_b: number;
  timestamp: string;
}

export interface NotificationRecord {
  id: string;
  type: string;
  message: string;
  dedup_key: string;
  sent_at: string;
}

export interface BacktestResult {
  id: number;
  config_json: string;
  pair: string | null;
  total_trades: number;
  win_rate: number;
  sharpe_ratio: number;
  max_drawdown: number;
  total_pnl: number;
  rank: number;
  tested_at: string;
}

export interface OHLCVCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderParams {
  instrument: string;
  side: LegSide;
  size: number;
  price?: number;
  leverage: number;
  reduceOnly?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  failures: string[];
}

export interface SizingResult {
  legASize: number;
  legBSize: number;
  legANotional: number;
  legBNotional: number;
  totalExposure: number;
}
