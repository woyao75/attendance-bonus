-- Local direct-email mode needs a fixed, trusted sender address and a
-- per-task-member secret. Existing memberships remain nullable and must be
-- recreated or completed by an administrator before direct-email check-in.
ALTER TABLE `User` ADD COLUMN `email` VARCHAR(320) NULL;
CREATE UNIQUE INDEX `User_email_key` ON `User`(`email`);

ALTER TABLE `TaskMember`
  ADD COLUMN `email` VARCHAR(320) NULL,
  ADD COLUMN `mailToken` CHAR(32) NULL;
CREATE UNIQUE INDEX `TaskMember_mailToken_key` ON `TaskMember`(`mailToken`);

-- Preserve known addresses for historical roster snapshots when available.
UPDATE `TaskMember` m
INNER JOIN `User` u ON u.`id` = m.`userId`
SET m.`email` = u.`email`
WHERE m.`email` IS NULL AND u.`email` IS NOT NULL;

CREATE TABLE `InboundMailLog` (
  `id` VARCHAR(30) NOT NULL,
  `messageId` VARCHAR(320) NOT NULL,
  `taskId` VARCHAR(30) NULL,
  `sender` VARCHAR(320) NULL,
  `subject` VARCHAR(320) NOT NULL,
  `status` VARCHAR(32) NOT NULL,
  `errorMsg` VARCHAR(500) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `InboundMailLog_messageId_key`(`messageId`),
  INDEX `InboundMailLog_taskId_createdAt_idx`(`taskId`, `createdAt`),
  INDEX `InboundMailLog_status_createdAt_idx`(`status`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
