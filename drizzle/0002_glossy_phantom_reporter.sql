ALTER TABLE `analysisManifests` MODIFY COLUMN `status` enum('queued','running','uploading','completed','failed','cancelled','discarded','expired') NOT NULL;--> statement-breakpoint
ALTER TABLE `analysisManifests` ADD `revokedAt` timestamp;--> statement-breakpoint
ALTER TABLE `analysisManifests` ADD `revocationReason` varchar(32);