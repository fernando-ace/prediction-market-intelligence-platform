ALTER TABLE "OrderbookSnapshot"
ADD COLUMN "validationFlags" JSONB,
ADD COLUMN "liquidityUsedByDetector" DECIMAL(18,6),
ADD COLUMN "parseWarnings" TEXT;

ALTER TABLE "PaperTrade"
ADD COLUMN "targetExecutionTime" TIMESTAMP(3),
ADD COLUMN "actualSnapshotExecutionTime" TIMESTAMP(3),
ADD COLUMN "yesAskAtSignal" DECIMAL(10,6),
ADD COLUMN "noAskAtSignal" DECIMAL(10,6),
ADD COLUMN "yesFillAveragePrice" DECIMAL(10,6),
ADD COLUMN "noFillAveragePrice" DECIMAL(10,6),
ADD COLUMN "yesContractsFilled" DECIMAL(18,6),
ADD COLUMN "noContractsFilled" DECIMAL(18,6),
ADD COLUMN "pairedContracts" DECIMAL(18,6),
ADD COLUMN "unpairedContractsDiscarded" DECIMAL(18,6),
ADD COLUMN "feeEstimate" DECIMAL(18,6),
ADD COLUMN "failureReason" TEXT;
