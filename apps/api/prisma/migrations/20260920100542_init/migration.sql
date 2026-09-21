-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(30) NOT NULL,
    `studentId` VARCHAR(64) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `role` VARCHAR(32) NOT NULL,
    `classId` VARCHAR(100) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_studentId_key`(`studentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Task` (
    `id` VARCHAR(30) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `startTime` DATETIME(3) NOT NULL,
    `endTime` DATETIME(3) NOT NULL,
    `targetEmail` VARCHAR(320) NOT NULL,
    `gestureImgUrl` VARCHAR(2048) NULL,
    `centerLat` DOUBLE NOT NULL,
    `centerLng` DOUBLE NOT NULL,
    `radius` INTEGER NOT NULL DEFAULT 800,
    `status` ENUM('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'ARCHIVED') NOT NULL DEFAULT 'NOT_STARTED',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CheckIn` (
    `id` VARCHAR(30) NOT NULL,
    `taskId` VARCHAR(30) NOT NULL,
    `userId` VARCHAR(30) NOT NULL,
    `status` ENUM('NOT_CHECKED', 'EMAIL_SENT', 'REVIEWING', 'APPROVED', 'REJECTED', 'EMAIL_ERROR') NOT NULL DEFAULT 'NOT_CHECKED',
    `photoUrl` VARCHAR(2048) NULL,
    `lat` DOUBLE NULL,
    `lng` DOUBLE NULL,
    `address` VARCHAR(300) NULL,
    `emailSubject` VARCHAR(320) NULL,
    `emailReceivedAt` DATETIME(3) NULL,
    `rejectReason` VARCHAR(300) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CheckIn_taskId_status_idx`(`taskId`, `status`),
    INDEX `CheckIn_userId_createdAt_idx`(`userId`, `createdAt`),
    UNIQUE INDEX `CheckIn_taskId_userId_key`(`taskId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmailLog` (
    `id` VARCHAR(30) NOT NULL,
    `taskId` VARCHAR(30) NOT NULL,
    `messageId` VARCHAR(320) NOT NULL,
    `subject` VARCHAR(320) NOT NULL,
    `parseStatus` VARCHAR(32) NOT NULL,
    `errorMsg` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `EmailLog_messageId_key`(`messageId`),
    INDEX `EmailLog_taskId_createdAt_idx`(`taskId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CheckIn` ADD CONSTRAINT `CheckIn_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CheckIn` ADD CONSTRAINT `CheckIn_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmailLog` ADD CONSTRAINT `EmailLog_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
