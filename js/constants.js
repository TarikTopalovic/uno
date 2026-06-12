export const COLORS = ['red', 'yellow', 'green', 'blue'];
export const HAND_SIZE = 7;
export const TARGET_SCORE = 500;
export const UNO_PENALTY = 2;
export const PLAYER_NAMES = ['YOU', 'NOVA', 'VEX', 'ECHO'];

export const PHASES = [
  'awaiting-initial-color',
  'awaiting-play',
  'awaiting-color',
  'awaiting-play-drawn',
  'round-over',
  'match-over',
];

export const AI_TUNING = {
  DECLARE_UNO_PROB: 0.9,
  EPSILON: 0.5,
  THREAT_HAND: 2,
  WEIGHTS: {
    shed: 0.1,
    colorRun: 1.5,
    draw2Threat: 8,
    skipThreat: 6,
    wild4Threat: 5,
    reverseThreat: 4,
    wildHold: -6,
    wild4Hold: -7,
  },
};

export const TIMING = {
  AI_THINK_MIN: 550,
  AI_THINK_MAX: 1100,
  CATCH_PROB: 0.65,
  CATCH_MIN: 700,
  CATCH_MAX: 1800,
  HUMAN_UNO_GRACE: 2100,
  AI_SELF_RESCUE_PROB: 0.55,
  AI_SELF_RESCUE_AT: 1000,
  AUTO_KEEP_MS: 5000,
  FLY_MS: 420,
  DEAL_STAGGER_MS: 70,
};
