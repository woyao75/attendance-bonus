-- Upgrade preserves existing users and check-ins. Existing accounts need a password reset.
UPDATE `User` SET `role` = CASE LOWER(`role`) WHEN 'admin' THEN 'ADMIN' WHEN 'counselor' THEN 'COUNSELOR' ELSE 'STUDENT' END;

-- DropForeignKey
ALTER TABLE `CheckIn` DROP FOREIGN KEY `CheckIn_taskId_fkey`;

-- DropForeignKey
ALTER TABLE `CheckIn` DROP FOREIGN KEY `CheckIn_userId_fkey`;

-- AlterTable
ALTER TABLE `User` ADD COLUMN `active` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `lockedUntil` DATETIME(3) NULL,
    ADD COLUMN `loginFailures` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `mustChangePassword` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `passwordHash` VARCHAR(255) NULL,
    MODIFY `role` ENUM('STUDENT', 'COUNSELOR', 'ADMIN') NOT NULL DEFAULT 'STUDENT',
    MODIFY `classId` VARCHAR(100) NULL;

-- AlterTable
ALTER TABLE `Task` ADD COLUMN `ownerId` VARCHAR(30) NULL;

-- AlterTable
ALTER TABLE `CheckIn` ADD COLUMN `accuracy` DOUBLE NULL,
    ADD COLUMN `attemptId` CHAR(36) NULL,
    ADD COLUMN `capturedAt` DATETIME(3) NULL,
    ADD COLUMN `photoHash` CHAR(64) NULL,
    ADD COLUMN `submittedAt` DATETIME(3) NULL,
    MODIFY `status` ENUM('NOT_CHECKED', 'EMAIL_PENDING', 'EMAIL_SENT', 'REVIEWING', 'APPROVED', 'REJECTED', 'EMAIL_ERROR') NOT NULL DEFAULT 'NOT_CHECKED';

-- CreateTable
CREATE TABLE `Class` (
    `id` VARCHAR(100) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `Class_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CounselorClass` (
    `userId` VARCHAR(30) NOT NULL,
    `classId` VARCHAR(100) NOT NULL,

    PRIMARY KEY (`userId`, `classId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Session` (
    `tokenHash` CHAR(64) NOT NULL,
    `userId` VARCHAR(30) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `Session_userId_idx`(`userId`),
    INDEX `Session_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`tokenHash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskMember` (
    `taskId` VARCHAR(30) NOT NULL,
    `userId` VARCHAR(30) NOT NULL,
    `studentId` VARCHAR(64) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `className` VARCHAR(100) NOT NULL,

    PRIMARY KEY (`taskId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MailOutbox` (
    `id` CHAR(36) NOT NULL,
    `checkInId` VARCHAR(30) NOT NULL,
    `subject` VARCHAR(320) NOT NULL,
    `body` TEXT NOT NULL,
    `photoUrl` VARCHAR(2048) NOT NULL,
    `targetEmail` VARCHAR(320) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sentAt` DATETIME(3) NULL,
    `error` VARCHAR(500) NULL,

    INDEX `MailOutbox_sentAt_nextAttemptAt_idx`(`sentAt`, `nextAttemptAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` VARCHAR(30) NOT NULL,
    `actorId` VARCHAR(30) NOT NULL,
    `action` VARCHAR(64) NOT NULL,
    `targetId` VARCHAR(100) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditLog_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `CheckIn_attemptId_key` ON `CheckIn`(`attemptId`);

-- AddForeignKey
ALTER TABLE `CounselorClass` ADD CONSTRAINT `CounselorClass_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CounselorClass` ADD CONSTRAINT `CounselorClass_classId_fkey` FOREIGN KEY (`classId`) REFERENCES `Class`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Session` ADD CONSTRAINT `Session_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve legacy class identifiers before adding the FK.
INSERT INTO `Class` (`id`, `name`)
SELECT DISTINCT `classId`, `classId` FROM `User` WHERE `classId` IS NOT NULL AND `classId` <> '';
UPDATE `User` SET `classId` = NULL WHERE `classId` = '';
UPDATE `CheckIn` SET `submittedAt` = `createdAt` WHERE `photoUrl` IS NOT NULL;
-- Prior MVP used all students as the roster; freeze that interpretation for old tasks.
INSERT INTO `TaskMember` (`taskId`, `userId`, `studentId`, `name`, `className`)
SELECT t.`id`, u.`id`, u.`studentId`, u.`name`, COALESCE(u.`classId`, '未分班')
FROM `Task` t CROSS JOIN `User` u WHERE u.`role` = 'STUDENT';

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_classId_fkey` FOREIGN KEY (`classId`) REFERENCES `Class`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Task` ADD CONSTRAINT `Task_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskMember` ADD CONSTRAINT `TaskMember_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskMember` ADD CONSTRAINT `TaskMember_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CheckIn` ADD CONSTRAINT `CheckIn_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CheckIn` ADD CONSTRAINT `CheckIn_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MailOutbox` ADD CONSTRAINT `MailOutbox_checkInId_fkey` FOREIGN KEY (`checkInId`) REFERENCES `CheckIn`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
