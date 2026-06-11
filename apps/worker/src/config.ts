import { defaultFeeSettings, type DetectionConfig } from "@prediction-market-scanner/core";

export interface WorkerConfig {
  kalshiBaseUrl: string;
  pollIntervalSeconds: number;
  marketPollIntervalSeconds: number;
  maxMarkets: number;
  kalshiCandidateMarketLimit: number;
  includeMveMarkets: boolean;
  paperExecutionDelaySeconds: number;
  detection: DetectionConfig;
}

export function loadWorkerConfig(): WorkerConfig {
  return {
    kalshiBaseUrl: readString("KALSHI_BASE_URL", "https://external-api.kalshi.com/trade-api/v2"),
    pollIntervalSeconds: readNumber("POLL_INTERVAL_SECONDS", 60),
    marketPollIntervalSeconds: 300,
    maxMarkets: readNumber("MAX_MARKETS", 25),
    kalshiCandidateMarketLimit: readNumber("KALSHI_CANDIDATE_MARKET_LIMIT", 500),
    includeMveMarkets: readBoolean("INCLUDE_MVE_MARKETS", false),
    paperExecutionDelaySeconds: readNumber("PAPER_EXECUTION_DELAY_SECONDS", 30),
    detection: {
      minNetEdge: readNumber("MIN_NET_EDGE", 0.005),
      minLiquidityContracts: readNumber("MIN_LIQUIDITY_CONTRACTS", 1),
      feeSettings: {
        ...defaultFeeSettings,
        feeBufferPerContract: readNumber("FEE_BUFFER_PER_CONTRACT", defaultFeeSettings.feeBufferPerContract),
        feeBufferPercentOfNotional: readNumber("FEE_BUFFER_PERCENT_OF_NOTIONAL", defaultFeeSettings.feeBufferPercentOfNotional ?? 0)
      }
    }
  };
}

function readString(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function readNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value);
}
