import { Router, type Request, type Response } from 'express';
import type { PackageMetadata } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { getMatchReasonMetadata } from '../matching/reasons.js';
import { matchDeviceApplications } from '../matching/service.js';
import { buildReleaseInfo } from '../metadata/releaseInfo.js';

export const deviceDataRouter = Router();

// GET /api/devices/:id/applications & GET /api/applications - List installed applications with optional includeRemoved
deviceDataRouter.get(
  ['/devices/:id/applications', '/v1/devices/:id/applications', '/applications', '/v1/applications'],
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    let targetDeviceId = req.params.id ? String(req.params.id) : (req.query.deviceId ? String(req.query.deviceId) : null);
    const user = req.user!;
    const includeRemoved = req.query.includeRemoved === 'true' || req.query.includeRemoved === '1';
    const matchStatusFilter = req.query.matchStatus ? String(req.query.matchStatus).toLowerCase() : undefined;
    const updateStatusFilter = req.query.updateStatus ? String(req.query.updateStatus).toLowerCase() : undefined;

    try {
      if (!targetDeviceId) {
        const firstDevice = await prisma.device.findFirst({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
        });
        if (firstDevice) {
          targetDeviceId = firstDevice.id;
        } else {
          res.status(200).json({
            success: true,
            data: {
              total: 0,
              applications: [],
              items: [],
            },
          });
          return;
        }
      }

      const device = await prisma.device.findUnique({
        where: { id: targetDeviceId },
      });

      if (!device || device.userId !== user.id) {
        res.status(404).json({
          success: false,
          error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
        });
        return;
      }

      const whereClause: {
        deviceId: string;
        isInstalled?: boolean;
        matchStatus?: string;
        updateStatus?: string;
      } = {
        deviceId: device.id,
      };

      if (!includeRemoved) {
        whereClause.isInstalled = true;
      }

      if (matchStatusFilter) {
        whereClause.matchStatus = matchStatusFilter;
      }

      if (updateStatusFilter) {
        whereClause.updateStatus = updateStatusFilter;
      }

      const applications = await prisma.application.findMany({
        where: whereClause,
        orderBy: { name: 'asc' },
      });

      const pkgIds = applications
        .map((a) => a.matchedPackageId || a.packageId)
        .filter((id): id is string => Boolean(id));

      let metadataList: PackageMetadata[] = [];
      try {
        if (pkgIds.length > 0 && prisma.packageMetadata) {
          metadataList = await prisma.packageMetadata.findMany({
            where: { packageId: { in: pkgIds } },
          });
        }
      } catch {
        metadataList = [];
      }

      const metaMap = new Map<string, PackageMetadata>();
      for (const m of metadataList) {
        metaMap.set(`${m.packageId.toLowerCase()}:${m.version.toLowerCase()}`, m);
        if (!metaMap.has(m.packageId.toLowerCase())) {
          metaMap.set(m.packageId.toLowerCase(), m);
        }
      }

      const formatted = applications.map((app) => {
        const lastSeen = app.lastScannedAt ? new Date(app.lastScannedAt).toISOString() : new Date().toISOString();
        const firstSeen = app.createdAt ? new Date(app.createdAt).toISOString() : new Date().toISOString();
        const updated = app.updatedAt ? new Date(app.updatedAt).toISOString() : new Date().toISOString();
        const reasonMeta = getMatchReasonMetadata(app.matchReason);

        const pkgId = app.matchedPackageId || app.packageId;
        const targetVer = app.availableVersion;
        const meta = (pkgId && targetVer)
          ? metaMap.get(`${pkgId.toLowerCase()}:${targetVer.toLowerCase()}`) || metaMap.get(pkgId.toLowerCase())
          : (pkgId ? metaMap.get(pkgId.toLowerCase()) : null);

        const releaseInfo = buildReleaseInfo(app.availableVersion, meta);

        return {
          id: app.id,
          name: app.name,
          version: app.installedVersion,
          publisher: meta?.publisher || app.publisher,
          packageId: app.packageId,
          source: app.source,
          lastSeenAt: lastSeen,
          firstSeenAt: firstSeen,
          isInstalled: app.isInstalled,
          isManaged: app.isManaged,
          installedVersion: app.installedVersion,
          availableVersion: app.availableVersion,
          updateStatus: app.updateStatus || 'not_checked',
          updateCheckedAt: app.updateCheckedAt ? new Date(app.updateCheckedAt).toISOString() : null,
          matchStatus: app.matchStatus || 'pending',
          matchReason: app.matchReason || null,
          matchMessage: reasonMeta.message,
          matchNextStep: reasonMeta.nextStep,
          matchedPackageId: app.matchedPackageId || null,
          matchConfidence: app.matchConfidence !== undefined && app.matchConfidence !== null ? app.matchConfidence : null,
          matchMethod: app.matchMethod || 'none',
          candidates: (app.candidates as unknown as unknown[]) || [],
          lastScannedAt: lastSeen,
          createdAt: firstSeen,
          updatedAt: updated,
          // Release info & source links
          releaseInfo,
          officialSourceLink: releaseInfo.officialSourceLink,
          releaseNotesLink: releaseInfo.releaseNotesLink,
          releaseNotesSummary: releaseInfo.releaseNotesSummary,
          metadataStatus: releaseInfo.status,
          missingMessages: releaseInfo.missingMessages,
        };
      });

      res.status(200).json({
        success: true,
        data: {
          total: formatted.length,
          applications: formatted,
          items: formatted,
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
      });
    }
  }
);

// POST /api/devices/:id/rematch - Rerun package matching without a new scan (owner only)
deviceDataRouter.post(
  '/devices/:id/rematch',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const deviceId = String(req.params.id);
    const user = req.user!;

    try {
      const device = await prisma.device.findUnique({
        where: { id: deviceId },
      });

      if (!device || device.userId !== user.id) {
        res.status(404).json({
          success: false,
          error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
        });
        return;
      }

      const summary = await matchDeviceApplications(device.id);

      // Audit the rematch event
      await prisma.auditEvent.create({
        data: {
          userId: user.id,
          deviceId: device.id,
          eventType: 'APPLICATIONS_REMATCHED',
          entityType: 'devices',
          entityId: device.id,
          metadata: {
            totalProcessed: summary.totalProcessed,
            updatedRowsCount: summary.updatedRowsCount,
            matchedCount: summary.matchedCount,
            ambiguousCount: summary.ambiguousCount,
            unsupportedCount: summary.unsupportedCount,
          },
        },
      });

      res.status(200).json({
        success: true,
        data: summary,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
      });
    }
  }
);

// GET /api/devices/:id/applications/:appId - Detailed application view with release info
deviceDataRouter.get(
  ['/devices/:id/applications/:appId', '/v1/devices/:id/applications/:appId'],
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const deviceId = String(req.params.id);
    const appId = String(req.params.appId);
    const user = req.user!;

    try {
      const device = await prisma.device.findUnique({ where: { id: deviceId } });
      if (!device || device.userId !== user.id) {
        res.status(404).json({
          success: false,
          error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
        });
        return;
      }

      const app = await prisma.application.findFirst({
        where: {
          deviceId: device.id,
          OR: [{ id: appId }, { packageId: appId }, { matchedPackageId: appId }],
        },
      });

      if (!app) {
        res.status(404).json({
          success: false,
          error: { code: 'APPLICATION_NOT_FOUND', message: 'Application not found' },
        });
        return;
      }

      const pkgId = app.matchedPackageId || app.packageId;
      let meta: PackageMetadata | null = null;
      if (pkgId) {
        if (app.availableVersion) {
          meta = await prisma.packageMetadata.findUnique({
            where: { packageId_version: { packageId: pkgId, version: app.availableVersion } },
          });
        }
        if (!meta) {
          meta = await prisma.packageMetadata.findFirst({
            where: { packageId: pkgId },
            orderBy: { fetchedAt: 'desc' },
          });
        }
      }

      const releaseInfo = buildReleaseInfo(app.availableVersion, meta);
      const reasonMeta = getMatchReasonMetadata(app.matchReason);

      res.status(200).json({
        success: true,
        data: {
          id: app.id,
          deviceId: app.deviceId,
          name: app.name,
          packageId: app.packageId || app.matchedPackageId,
          installedVersion: app.installedVersion,
          availableVersion: app.availableVersion,
          updateStatus: app.updateStatus || 'not_checked',
          updateCheckedAt: app.updateCheckedAt ? app.updateCheckedAt.toISOString() : null,
          isInstalled: app.isInstalled,
          isManaged: app.isManaged,
          source: app.source,
          publisher: meta?.publisher || app.publisher,
          matchStatus: app.matchStatus || 'pending',
          matchReason: app.matchReason || null,
          matchMessage: reasonMeta.message,
          matchNextStep: reasonMeta.nextStep,
          matchedPackageId: app.matchedPackageId || null,
          matchConfidence: app.matchConfidence,
          matchMethod: app.matchMethod || 'none',
          candidates: app.candidates || [],
          releaseInfo,
          // Release info top-level fields
          version: releaseInfo.version,
          officialSourceLink: releaseInfo.officialSourceLink,
          releaseNotesLink: releaseInfo.releaseNotesLink,
          releaseNotesSummary: releaseInfo.releaseNotesSummary,
          fetchedAt: releaseInfo.fetchedAt,
          metadataStatus: releaseInfo.status,
          status: releaseInfo.status,
          missingMessages: releaseInfo.missingMessages,
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
      });
    }
  }
);

// GET /api/devices/:id/updates/:updateId - Update details API with release info
deviceDataRouter.get(
  ['/devices/:id/updates/:updateId', '/v1/devices/:id/updates/:updateId'],
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const deviceId = String(req.params.id);
    const updateId = String(req.params.updateId);
    const user = req.user!;

    try {
      const device = await prisma.device.findUnique({ where: { id: deviceId } });
      if (!device || device.userId !== user.id) {
        res.status(404).json({
          success: false,
          error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
        });
        return;
      }

      const app = await prisma.application.findFirst({
        where: {
          deviceId: device.id,
          OR: [{ id: updateId }, { packageId: updateId }, { matchedPackageId: updateId }],
        },
      });

      if (!app) {
        res.status(404).json({
          success: false,
          error: { code: 'UPDATE_NOT_FOUND', message: 'Update record not found' },
        });
        return;
      }

      const pkgId = app.matchedPackageId || app.packageId;
      let meta: PackageMetadata | null = null;
      if (pkgId) {
        if (app.availableVersion) {
          meta = await prisma.packageMetadata.findUnique({
            where: { packageId_version: { packageId: pkgId, version: app.availableVersion } },
          });
        }
        if (!meta) {
          meta = await prisma.packageMetadata.findFirst({
            where: { packageId: pkgId },
            orderBy: { fetchedAt: 'desc' },
          });
        }
      }

      const releaseInfo = buildReleaseInfo(app.availableVersion, meta);

      res.status(200).json({
        success: true,
        data: {
          id: app.id,
          deviceId: app.deviceId,
          name: app.name,
          packageId: app.packageId || app.matchedPackageId,
          currentVersion: app.installedVersion,
          installedVersion: app.installedVersion,
          targetVersion: app.availableVersion,
          availableVersion: app.availableVersion,
          updateStatus: app.updateStatus || 'not_checked',
          updateCheckedAt: app.updateCheckedAt ? app.updateCheckedAt.toISOString() : null,
          publisher: meta?.publisher || app.publisher,
          source: app.source || 'winget',
          matchStatus: app.matchStatus || 'matched',
          // Release info fields directly on response data
          version: releaseInfo.version,
          officialSourceLink: releaseInfo.officialSourceLink,
          releaseNotesLink: releaseInfo.releaseNotesLink,
          releaseNotesSummary: releaseInfo.releaseNotesSummary,
          fetchedAt: releaseInfo.fetchedAt,
          metadataStatus: releaseInfo.status,
          status: releaseInfo.status,
          missingMessages: releaseInfo.missingMessages,
          releaseInfo,
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
      });
    }
  }
);

// GET /api/devices/:id/updates/pending & GET /api/devices/:id/updates - List pending updates with release info
deviceDataRouter.get(
  [
    '/devices/:id/updates/pending',
    '/v1/devices/:id/updates/pending',
    '/devices/:id/updates',
    '/v1/devices/:id/updates',
    '/updates/pending',
  ],
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    let targetDeviceId = req.params.id ? String(req.params.id) : (req.query.deviceId ? String(req.query.deviceId) : null);
    const user = req.user!;

    try {
      if (!targetDeviceId) {
        const firstDevice = await prisma.device.findFirst({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
        });
        if (!firstDevice) {
          res.status(200).json({ success: true, data: [] });
          return;
        }
        targetDeviceId = firstDevice.id;
      }

      const device = await prisma.device.findUnique({ where: { id: targetDeviceId } });
      if (!device || device.userId !== user.id) {
        res.status(404).json({
          success: false,
          error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
        });
        return;
      }

      const appsWithUpdates = await prisma.application.findMany({
        where: {
          deviceId: device.id,
          isInstalled: true,
          updateStatus: 'update_available',
        },
        orderBy: { name: 'asc' },
      });

      const pkgIds = appsWithUpdates
        .map((a) => a.matchedPackageId || a.packageId)
        .filter((id): id is string => Boolean(id));

      let metadataList: PackageMetadata[] = [];
      try {
        if (pkgIds.length > 0 && prisma.packageMetadata) {
          metadataList = await prisma.packageMetadata.findMany({
            where: { packageId: { in: pkgIds } },
          });
        }
      } catch {
        metadataList = [];
      }

      const metaMap = new Map<string, PackageMetadata>();
      for (const m of metadataList) {
        metaMap.set(`${m.packageId.toLowerCase()}:${m.version.toLowerCase()}`, m);
        if (!metaMap.has(m.packageId.toLowerCase())) {
          metaMap.set(m.packageId.toLowerCase(), m);
        }
      }

      const updates = appsWithUpdates.map((app) => {
        const pkgId = app.matchedPackageId || app.packageId;
        const targetVer = app.availableVersion;
        const meta = (pkgId && targetVer)
          ? metaMap.get(`${pkgId.toLowerCase()}:${targetVer.toLowerCase()}`) || metaMap.get(pkgId.toLowerCase())
          : (pkgId ? metaMap.get(pkgId.toLowerCase()) : null);

        const releaseInfo = buildReleaseInfo(app.availableVersion, meta);

        return {
          id: app.id,
          deviceId: device.id,
          deviceName: device.name,
          name: app.name,
          packageId: app.matchedPackageId || app.packageId || '',
          currentVersion: app.installedVersion,
          targetVersion: app.availableVersion || '',
          source: app.source || 'winget',
          status: 'PENDING_APPROVAL',
          matchStatus: app.matchStatus || 'matched',
          matchReason: app.matchReason || null,
          detectedAt: app.updateCheckedAt ? app.updateCheckedAt.toISOString() : app.updatedAt.toISOString(),
          publisher: meta?.publisher || app.publisher,
          version: releaseInfo.version,
          officialSourceLink: releaseInfo.officialSourceLink,
          releaseNotesLink: releaseInfo.releaseNotesLink,
          releaseNotesSummary: releaseInfo.releaseNotesSummary,
          fetchedAt: releaseInfo.fetchedAt,
          metadataStatus: releaseInfo.status,
          statusText: releaseInfo.status,
          missingMessages: releaseInfo.missingMessages,
          releaseInfo,
        };
      });

      res.status(200).json({ success: true, data: updates });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
      });
    }
  }
);

// GET /api/devices/:id/overview - Dashboard summary using real scan data
deviceDataRouter.get(
  ['/devices/:id/overview', '/dashboard/summary', '/overview'],
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    let targetDeviceId = req.params.id ? String(req.params.id) : (req.query.deviceId ? String(req.query.deviceId) : null);
    const user = req.user!;

    try {
      if (!targetDeviceId && req.path === '/overview') {
        const firstDevice = await prisma.device.findFirst({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
        });
        if (firstDevice) {
          targetDeviceId = firstDevice.id;
        } else {
          res.status(200).json({
            success: true,
            data: {
              totalApps: 0,
              managedApps: 0,
              unsupportedApps: 0,
              updatesAvailableCount: 0,
              upToDateCount: 0,
              unknownUpdateCount: 0,
              updatesAvailable: 0,
              upToDate: 0,
              unknownUpdates: 0,
              pendingUpdatesCount: 0,
              lastScanStatus: 'NEVER',
              lastScanAt: null,
              agentStatus: 'OFFLINE',
              agentHostname: '—',
              device: null,
              metrics: {
                total_apps_count: 0,
                managed_apps_count: 0,
                unsupported_apps_count: 0,
                updates_available_count: 0,
                up_to_date_count: 0,
                unknown_update_count: 0,
                pending_updates_count: 0,
                last_scan_status: 'NEVER',
                last_scan_at: null,
              },
              recentActivity: [],
              quickPendingUpdates: [],
            },
          });
          return;
        }
      }

      if (!targetDeviceId) {
        res.status(400).json({
          success: false,
          error: { code: 'DEVICE_ID_REQUIRED', message: 'Target device ID is required' },
        });
        return;
      }

      const device = await prisma.device.findUnique({
        where: { id: targetDeviceId },
      });

      if (!device || device.userId !== user.id) {
        res.status(404).json({
          success: false,
          error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
        });
        return;
      }

      // Real scan counts from applications table
      const totalApps = await prisma.application.count({
        where: { deviceId: device.id, isInstalled: true },
      });

      const managedApps = await prisma.application.count({
        where: { deviceId: device.id, isInstalled: true, isManaged: true },
      });

      const unsupportedApps = totalApps - managedApps;

      // Pending updates count (apps with an available update version)
      const pendingUpdatesCount = await prisma.application.count({
        where: {
          deviceId: device.id,
          isInstalled: true,
          availableVersion: { not: null },
        },
      });

      // Latest scan job
      const latestScan = await prisma.scanJob.findFirst({
        where: { deviceId: device.id },
        orderBy: { createdAt: 'desc' },
      });

      const lastScanStatus = latestScan ? latestScan.status : 'NEVER';
      const lastScanAt = latestScan?.finishedAt
        ? latestScan.finishedAt.toISOString()
        : latestScan?.createdAt
        ? latestScan.createdAt.toISOString()
        : null;

      // Match status counts
      const matchedApps = await prisma.application.count({
        where: { deviceId: device.id, isInstalled: true, matchStatus: 'matched' },
      });

      const ambiguousApps = await prisma.application.count({
        where: { deviceId: device.id, isInstalled: true, matchStatus: 'ambiguous' },
      });

      const unsupportedAppsCount = await prisma.application.count({
        where: { deviceId: device.id, isInstalled: true, matchStatus: 'unsupported' },
      });

      // Update status counts
      const updatesAvailableCount = await prisma.application.count({
        where: { deviceId: device.id, isInstalled: true, updateStatus: 'update_available' },
      });

      const upToDateCount = await prisma.application.count({
        where: { deviceId: device.id, isInstalled: true, updateStatus: 'up_to_date' },
      });

      const unknownUpdateCount = await prisma.application.count({
        where: { deviceId: device.id, isInstalled: true, updateStatus: 'unknown' },
      });

      const data = {
        totalApps,
        managedApps,
        unsupportedApps,
        matchedApps,
        ambiguousApps,
        matchedCount: matchedApps,
        ambiguousCount: ambiguousApps,
        unsupportedCount: unsupportedAppsCount,
        updatesAvailableCount,
        upToDateCount,
        unknownUpdateCount,
        updatesAvailable: updatesAvailableCount,
        upToDate: upToDateCount,
        unknownUpdates: unknownUpdateCount,
        pendingUpdatesCount,
        lastScanStatus,
        lastScanAt,
        agentStatus: device.status,
        agentHostname: device.hostname,
        device: {
          id: device.id,
          name: device.name,
          computer_name: device.hostname,
          status: device.status,
          last_heartbeat_at: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
        },
        metrics: {
          total_apps_count: totalApps,
          managed_apps_count: managedApps,
          unsupported_apps_count: unsupportedAppsCount > 0 ? unsupportedAppsCount : unsupportedApps,
          matched_apps_count: matchedApps,
          ambiguous_apps_count: ambiguousApps,
          matched_count: matchedApps,
          ambiguous_count: ambiguousApps,
          unsupported_count: unsupportedAppsCount > 0 ? unsupportedAppsCount : unsupportedApps,
          updates_available_count: updatesAvailableCount,
          up_to_date_count: upToDateCount,
          unknown_update_count: unknownUpdateCount,
          pending_updates_count: pendingUpdatesCount,
          last_scan_status: lastScanStatus,
          last_scan_at: lastScanAt,
        },
        recentActivity: [],
        quickPendingUpdates: [],
      };

      res.status(200).json({
        success: true,
        data,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
      });
    }
  }
);

// GET /api/devices/:id/history & GET /api/history - Scan jobs history with status, duration, app count and error message
deviceDataRouter.get(
  ['/devices/:id/history', '/v1/devices/:id/history', '/history', '/v1/history'],
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    let targetDeviceId = req.params.id ? String(req.params.id) : (req.query.deviceId ? String(req.query.deviceId) : null);
    const user = req.user!;

    try {
      if (!targetDeviceId) {
        const firstDevice = await prisma.device.findFirst({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
        });
        if (firstDevice) {
          targetDeviceId = firstDevice.id;
        } else {
          res.status(200).json({
            success: true,
            data: [],
          });
          return;
        }
      }

      const device = await prisma.device.findUnique({
        where: { id: targetDeviceId },
      });

      if (!device || device.userId !== user.id) {
        res.status(404).json({
          success: false,
          error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
        });
        return;
      }

      const jobs = await prisma.scanJob.findMany({
        where: { deviceId: device.id },
        orderBy: { createdAt: 'desc' },
      });

      const history = jobs.map((job) => {
        let durationSeconds: number | null = null;
        if (job.startedAt && job.finishedAt) {
          durationSeconds = Math.max(
            0,
            Math.round((job.finishedAt.getTime() - job.startedAt.getTime()) / 1000)
          );
        }

        return {
          id: job.id,
          jobType: job.type,
          eventType: 'SCAN',
          title: `Scan (${job.status})`,
          target: device.hostname,
          status: job.status,
          duration: durationSeconds,
          durationSeconds,
          duration_seconds: durationSeconds,
          appCount: job.appCount,
          app_count: job.appCount,
          errorCode: job.errorCode,
          exitCode: job.errorCode,
          errorMessage: job.errorMessage,
          error_message: job.errorMessage,
          timestamp: job.createdAt.toISOString(),
          startedAt: job.startedAt ? job.startedAt.toISOString() : null,
          finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
          operator: user.email,
        };
      });

      res.status(200).json({
        success: true,
        data: history,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
      });
    }
  }
);

// GET /api/devices & GET /api/v1/devices - List devices for the user
deviceDataRouter.get(
  ['/devices', '/v1/devices'],
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    try {
      const devices = await prisma.device.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
      });

      const formatted = devices.map((d) => ({
        id: d.id,
        name: d.name,
        hostname: d.hostname,
        os: d.osVersion,
        osVersion: d.osVersion,
        agentVersion: d.agentVersion,
        status: d.status,
        connectionStatus: d.status === 'ONLINE' ? 'Online' : (d.status === 'REVOKED' ? 'Revoked' : 'Offline'),
        lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
        pairedAt: d.createdAt.toISOString(),
      }));

      res.status(200).json({
        success: true,
        data: formatted,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
      });
    }
  }
);

interface ActivePairingCode {
  code: string;
  userId: string;
  expiresAt: number;
  redeemed: boolean;
}

const activePairingCodes = new Map<string, ActivePairingCode>();

export function getActivePairingCode(code: string): ActivePairingCode | undefined {
  return activePairingCodes.get(code);
}

export function redeemPairingCode(code: string): boolean {
  const item = activePairingCodes.get(code);
  if (!item) return false;
  item.redeemed = true;
  return true;
}

// POST /api/devices/pairing-token & POST /api/v1/devices/pairing-token - Generate a pairing code
deviceDataRouter.post(
  ['/devices/pairing-token', '/v1/devices/pairing-token'],
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const user = req.user!;
      // Generate a 6-character random alphanumeric code or token
      const codeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += codeChars.charAt(Math.floor(Math.random() * codeChars.length));
      }
      const expiresInSeconds = 900;
      const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

      activePairingCodes.set(code, {
        code,
        userId: user.id,
        expiresAt: expiresAt.getTime(),
        redeemed: false,
      });

      res.status(201).json({
        success: true,
        data: {
          code,
          pairing_token: code,
          token: code,
          expires_at: expiresAt.toISOString(),
          expires_in_seconds: expiresInSeconds,
          pairing_command: `python agent.py pair --server http://localhost:3000 --code ${code}`,
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
      });
    }
  }
);

// POST /api/devices/:id/revoke & POST /api/v1/devices/:id/revoke - Revoke a device
deviceDataRouter.post(
  ['/devices/:id/revoke', '/v1/devices/:id/revoke'],
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const deviceId = String(req.params.id);
    const user = req.user!;
    try {
      const device = await prisma.device.findUnique({
        where: { id: deviceId },
      });

      if (!device || device.userId !== user.id) {
        res.status(404).json({
          success: false,
          error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
        });
        return;
      }

      await prisma.device.update({
        where: { id: device.id },
        data: { status: 'REVOKED' },
      });

      await prisma.agentCredential.updateMany({
        where: { deviceId: device.id },
        data: { revokedAt: new Date() },
      });

      res.status(200).json({
        success: true,
        data: { id: device.id, status: 'REVOKED' },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
      });
    }
  }
);
