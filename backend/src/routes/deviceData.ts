import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { getMatchReasonMetadata } from '../matching/reasons.js';
import { matchDeviceApplications } from '../matching/service.js';

export const deviceDataRouter = Router();

// GET /api/devices/:id/applications - List installed applications with optional includeRemoved
deviceDataRouter.get(
  '/devices/:id/applications',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const deviceId = String(req.params.id);
    const user = req.user!;
    const includeRemoved = req.query.includeRemoved === 'true' || req.query.includeRemoved === '1';
    const matchStatusFilter = req.query.matchStatus ? String(req.query.matchStatus).toLowerCase() : undefined;

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

      const whereClause: { deviceId: string; isInstalled?: boolean; matchStatus?: string } = {
        deviceId: device.id,
      };

      if (!includeRemoved) {
        whereClause.isInstalled = true;
      }

      if (matchStatusFilter) {
        whereClause.matchStatus = matchStatusFilter;
      }

      const applications = await prisma.application.findMany({
        where: whereClause,
        orderBy: { name: 'asc' },
      });

      const formatted = applications.map((app) => {
        const lastSeen = app.lastScannedAt ? new Date(app.lastScannedAt).toISOString() : new Date().toISOString();
        const firstSeen = app.createdAt ? new Date(app.createdAt).toISOString() : new Date().toISOString();
        const updated = app.updatedAt ? new Date(app.updatedAt).toISOString() : new Date().toISOString();
        const reasonMeta = getMatchReasonMetadata(app.matchReason);

        return {
          id: app.id,
          name: app.name,
          version: app.installedVersion,
          publisher: app.publisher,
          packageId: app.packageId,
          source: app.source,
          lastSeenAt: lastSeen,
          firstSeenAt: firstSeen,
          isInstalled: app.isInstalled,
          isManaged: app.isManaged,
          installedVersion: app.installedVersion,
          availableVersion: app.availableVersion,
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

      const data = {
        totalApps,
        managedApps,
        unsupportedApps,
        matchedApps,
        ambiguousApps,
        matchedCount: matchedApps,
        ambiguousCount: ambiguousApps,
        unsupportedCount: unsupportedAppsCount,
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

// GET /api/devices/:id/history - Scan jobs history with status, duration, app count and error message
deviceDataRouter.get(
  '/devices/:id/history',
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
