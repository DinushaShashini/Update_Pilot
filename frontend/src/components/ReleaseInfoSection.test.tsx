import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReleaseInfoSection } from './ReleaseInfoSection';
import * as updatesApi from '../api/updates';

describe('ReleaseInfoSection Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders target version, publisher, official source link with hostname and rel="noopener noreferrer", and release notes', () => {
    render(
      <ReleaseInfoSection
        targetVersion="2.56.0"
        publisher="The Git Development Community"
        officialSourceLink="https://git-scm.com/"
        releaseNotesLink="https://github.com/git-for-windows/git/releases/tag/v2.56.0"
        releaseNotesSummary="* Full security updates in 2.56.0&#10;* Fixed path normalization"
        fetchedAt={new Date(Date.now() - 3 * 3600 * 1000).toISOString()} // 3 hours ago
        metadataStatus="available"
        packageId="Git.Git"
      />
    );

    // Target version & publisher
    expect(screen.getByTestId('target-version-value').textContent).toBe('2.56.0');
    expect(screen.getByTestId('publisher-value').textContent).toBe('The Git Development Community');

    // Official source link
    const link = screen.getByTestId('official-source-link') as HTMLAnchorElement;
    expect(link).toBeDefined();
    expect(link.href).toBe('https://git-scm.com/');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(link.textContent).toContain('git-scm.com');

    // Release notes rendered as raw plain text
    const notes = screen.getByTestId('release-notes-text');
    expect(notes.textContent).toContain('* Full security updates in 2.56.0');

    // Relative time indicator
    expect(screen.getByTestId('metadata-updated-time').textContent).toBe('Information last updated 3 hours ago');

    // Refresh button
    expect(screen.getByTestId('btn-refresh-metadata')).toBeDefined();
  });

  it('handles partial state: missing release notes shows friendly fallback', () => {
    render(
      <ReleaseInfoSection
        targetVersion="9.1.0"
        publisher="Vim Devs"
        officialSourceLink="https://vim.org/"
        releaseNotesLink={null}
        releaseNotesSummary={null}
        fetchedAt={new Date().toISOString()}
        metadataStatus="partial"
        missingMessages={{
          releaseNotes: 'Release notes not provided by the publisher',
        }}
        packageId="Vim.Vim"
      />
    );

    expect(screen.getByTestId('official-source-link')).toBeDefined();
    expect(screen.getByTestId('release-notes-empty').textContent).toBe('Release notes not provided by the publisher');
  });

  it('handles partial state: missing official link shows friendly fallback', () => {
    render(
      <ReleaseInfoSection
        targetVersion="1.0.0"
        publisher="Open Tools"
        officialSourceLink={null}
        releaseNotesSummary="Some update text"
        fetchedAt={new Date().toISOString()}
        metadataStatus="partial"
        missingMessages={{
          officialSourceLink: 'Official source link not provided by the publisher',
        }}
        packageId="Open.Tools"
      />
    );

    expect(screen.queryByTestId('official-source-link')).toBeNull();
    expect(screen.getByTestId('official-source-missing').textContent).toBe(
      'Official source link not provided by the publisher'
    );
    expect(screen.getByTestId('release-notes-text').textContent).toBe('Some update text');
  });

  it('never renders unsafe links (javascript:, data:, http:) and treats them as missing', () => {
    render(
      <ReleaseInfoSection
        targetVersion="1.0.0"
        publisher="Risky Corp"
        officialSourceLink="javascript:alert(1)"
        releaseNotesLink="http://insecure-site.com/notes"
        releaseNotesSummary="Safe plain text"
        fetchedAt={new Date().toISOString()}
        packageId="Risky.App"
      />
    );

    // Unsafe URLs must not be rendered as hyperlinks
    expect(screen.queryByTestId('official-source-link')).toBeNull();
    expect(screen.queryByTestId('release-notes-link')).toBeNull();
    expect(screen.getByTestId('official-source-missing')).toBeDefined();
    // Plain text is safe
    expect(screen.getByTestId('release-notes-text').textContent).toBe('Safe plain text');
  });

  it('triggers refresh and handles loading and error states', async () => {
    const refreshSpy = vi.spyOn(updatesApi, 'refreshMetadata').mockResolvedValue({ queued: true });
    const onRefreshMock = vi.fn();

    render(
      <ReleaseInfoSection
        targetVersion="2.56.0"
        publisher="Git"
        officialSourceLink="https://git-scm.com/"
        packageId="Git.Git"
        deviceId="dev-1"
        onRefresh={onRefreshMock}
      />
    );

    const refreshBtn = screen.getByTestId('btn-refresh-metadata');
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledWith('dev-1', 'Git.Git');
      expect(onRefreshMock).toHaveBeenCalled();
      expect(screen.getByTestId('refresh-feedback').textContent).toContain('Refresh queued');
    });
  });

  it('displays rate-limit error message when refresh returns an error', async () => {
    vi.spyOn(updatesApi, 'refreshMetadata').mockRejectedValue(new Error('Rate limited. Please wait 10 seconds.'));

    render(
      <ReleaseInfoSection
        targetVersion="2.56.0"
        packageId="Git.Git"
        deviceId="dev-1"
      />
    );

    const refreshBtn = screen.getByTestId('btn-refresh-metadata');
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(screen.getByTestId('refresh-feedback').textContent).toContain('Rate limited. Please wait 10 seconds.');
    });
  });

  it('renders stale warning banner when metadataStatus is "stale"', () => {
    render(
      <ReleaseInfoSection
        targetVersion="24.08"
        metadataStatus="stale"
        packageId="7zip.7zip"
      />
    );

    expect(screen.getByTestId('metadata-stale-banner')).toBeDefined();
    expect(screen.getByTestId('metadata-stale-banner').textContent).toContain('Information is stale');
  });
});
