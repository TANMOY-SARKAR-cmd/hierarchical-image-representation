CREATE TABLE `analysisManifests` (
	`jobId` varchar(64) NOT NULL,
	`ownerId` varchar(64) NOT NULL,
	`status` enum('queued','running','uploading','completed','failed','cancelled','discarded') NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`completedAt` timestamp,
	`discardedAt` timestamp,
	`error` text,
	`payload` mediumtext,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `analysisManifests_jobId` PRIMARY KEY(`jobId`)
);
