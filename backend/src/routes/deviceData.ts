import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';

export const deviceDataRouter = Router();

// GET /api/devices/:id/applications - List installed applications with optional includeRemoved
deviceDataRouter.get(
  '/devices/:id/applications',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const deviceId = String(req.params.id);
    const user = req.user!;
    const includeRemoved = req.query.includeRemoved === 'true' || req.query.includeRemoved === '1';

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

      const whereClause: { deviceId: string; isInstalled?: boolean } = {
        deviceId: device.id,
      };

      if (!includeRemoved) {
        whereClause.isInstalled = true;
      }

      const applications = await prisma.application.findMany({
        where: whereClause,
        orderBy: { name: 'asc' },
      });

      const formatted = applications.map((app) => {
        const lastSeen = app.lastScannedAt ? new Date(app.lastScannedAt).toISOString() : new Date().toISOString();
        const firstSeen = app.createdAt ? new Date(app.createdAt).toISOString() : new Date().toISOString();
        const updated = app.updatedAt ? new Date(app.updatedAt).toISOString() : new Date().toISOString();

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

      const data = {
        totalApps,
        managedApps,
        unsupportedApps,
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
          unsupported_apps_count: unsupportedApps,
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
