import actionsheet from './actionSheet/actionSheet';
import { startResumableDownload } from './offlineResumable';

// Custom v12.1 candidate. The original Download action remains unchanged.
export const OFFLINE_QUALITIES = Object.freeze(['540p', '720p', '1080p']);
export const MAX_BUFFERED_BYTES = 1024 * 1024 * 1024;

export function makeOfflineUrl(apiClient, itemId, quality, selection = {}) {
    if (!/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(itemId) || !OFFLINE_QUALITIES.includes(quality)) {
        throw new Error('Invalid offline download selection.');
    }
    const query = { quality };
    for (const key of ['audioStreamIndex', 'subtitleStreamIndex']) {
        if (selection[key] != null) {
            if (!Number.isSafeInteger(selection[key]) || selection[key] < 0) throw new Error('Invalid track selection.');
            query[key] = selection[key];
        }
    }
    if (selection.subtitleMode != null && selection.subtitleMode !== 'none') {
        if (!['embed', 'burn'].includes(selection.subtitleMode) || selection.subtitleStreamIndex == null) throw new Error('Invalid subtitle selection.');
        query.subtitleMode = selection.subtitleMode;
    } else if (selection.subtitleStreamIndex != null) {
        throw new Error('Choose a subtitle mode.');
    }
    return apiClient.getUrl(`Videos/${encodeURIComponent(itemId)}/download.mp4`, query);
}

function authenticatedOptions(apiClient) {
    const token = apiClient.accessToken();
    if (!token || /[\r\n"]/.test(token)) throw new Error('A signed-in user session is required.');
    return { headers: { Authorization: `MediaBrowser Token="${token}"` }, cache: 'no-store', credentials: 'omit', redirect: 'error' };
}

export async function chooseOfflineTracks(apiClient, itemId) {
    // Validate the id before constructing the metadata URL; never accept source paths/codecs from the client.
    makeOfflineUrl(apiClient, itemId, '720p');
    const response = await fetch(apiClient.getUrl(`Videos/${encodeURIComponent(itemId)}/OfflineDownloadOptions`), authenticatedOptions(apiClient));
    if (!response.ok) throw new Error(`Offline track selection failed (HTTP ${response.status}).`);
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('Content-Type') || '')) throw new Error('The server did not return track metadata.');
    const options = await response.json();
    const selection = { subtitleMode: 'none' };
    const audio = (options.AudioTracks || []).filter(track => Number.isSafeInteger(track.Index) && track.Index >= 0);
    if (audio.length > 1) {
        const choices = [{ id: 'default', name: 'Default audio track' }, ...audio.map(track => ({ id: String(track.Index), name: track.DisplayTitle || track.Language || `Audio ${track.Index}` }))];
        const picked = await actionsheet.show({ title: 'Choose offline audio', items: choices });
        if (!choices.some(choice => choice.id === picked)) return null;
        if (picked !== 'default') selection.audioStreamIndex = Number(picked);
    } else if (audio.length === 1) {
        selection.audioStreamIndex = audio[0].Index;
    }
    const subtitles = (options.SubtitleTracks || []).filter(track => Number.isSafeInteger(track.Index) && track.Index >= 0);
    const choices = [{ id: 'none', name: 'No subtitles' }];
    for (const track of subtitles) {
        const label = track.DisplayTitle || track.Language || `Subtitle ${track.Index}`;
        if (track.CanEmbed) choices.push({ id: `embed:${track.Index}`, name: `${label} - switchable text (styling may be simplified)` });
        if (track.CanBurn) choices.push({ id: `burn:${track.Index}`, name: `${label} - burned in (always visible)` });
    }
    if (choices.length > 1) {
        const picked = await actionsheet.show({ title: 'Choose offline subtitles', items: choices });
        if (!choices.some(choice => choice.id === picked)) return null;
        if (picked !== 'none') {
            const [mode, index] = picked.split(':');
            selection.subtitleMode = mode;
            selection.subtitleStreamIndex = Number(index);
        }
    }
    return selection;
}

export function makeOfflineFilename(name, quality) {
    if (!OFFLINE_QUALITIES.includes(quality)) throw new Error('Unknown quality.');
    const forbidden = '<>:"/\\|?*';
    let stem = Array.from(String(name || 'video').slice(0, 120), (character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 || forbidden.includes(character) ? '_' : character;
    }).join('');
    while (stem.endsWith('.') || stem.endsWith(' ')) stem = stem.slice(0, -1);
    return `${stem || 'video'} - ${quality}.mp4`;
}

export async function showOfflineDownload(apiClient, item) {
    makeOfflineUrl(apiClient, item.Id, '720p');
    const response = await fetch(apiClient.getUrl(`Videos/${encodeURIComponent(item.Id)}/OfflineDownloads`), authenticatedOptions(apiClient));
    if (!response.ok) throw new Error(`Cannot list resumable downloads (HTTP ${response.status}).`);
    const jobs = await response.json();
    const pending = Array.isArray(jobs) ? jobs.filter(job => ['Queued', 'Preparing', 'Ready'].includes(job.Status)) : [];
    if (pending.length) {
        const choices = [{ id: 'new', name: 'Prepare a different quality or track selection' }, ...pending.map(job => ({ id: job.Id, name: `Resume ${job.Quality}, audio ${job.AudioStreamIndex ?? 'default'}, subtitles ${job.SubtitleMode} (${job.Status})` }))];
        const picked = await actionsheet.show({ title: 'Resume or prepare an offline download', items: choices });
        if (!choices.some(choice => choice.id === picked)) return;
        if (picked !== 'new') {
            const job = pending.find(entry => entry.Id === picked);
            return startResumableDownload(apiClient, item, job.Quality, { audioStreamIndex: job.AudioStreamIndex, subtitleStreamIndex: job.SubtitleStreamIndex, subtitleMode: job.SubtitleMode }, makeOfflineFilename(item.Name, job.Quality));
        }
    }
    const quality = await actionsheet.show({
        title: 'Download for offline viewing',
        items: [
            { id: '540p', name: '540p - smaller file (H.264 / stereo AAC)' },
            { id: '720p', name: '720p - recommended (H.264 / stereo AAC)' },
            { id: '1080p', name: '1080p - higher quality (H.264 / stereo AAC)' }
        ]
    });
    if (!OFFLINE_QUALITIES.includes(quality)) return;
    const selection = await chooseOfflineTracks(apiClient, item.Id);
    if (!selection) return;
    return startResumableDownload(apiClient, item, quality, selection, makeOfflineFilename(item.Name, quality));
}

// Diagnostic/backwards-compatible single-request path; the context menu uses resumable preparation above.
export async function showLegacyOfflineDownload(apiClient, item) {
    const quality = await actionsheet.show({
        title: 'Download for offline viewing',
        items: [
            { id: '540p', name: '540p - smaller file (H.264 / stereo AAC)' },
            { id: '720p', name: '720p - recommended (H.264 / stereo AAC)' },
            { id: '1080p', name: '1080p - higher quality (H.264 / stereo AAC)' }
        ]
    });
    if (!OFFLINE_QUALITIES.includes(quality)) return;
    const selection = await chooseOfflineTracks(apiClient, item.Id);
    if (!selection) return;

    const filename = makeOfflineFilename(item.Name, quality);
    let writable;
    if (window.isSecureContext && typeof window.showSaveFilePicker === 'function') {
        try {
            const accept = {};
            accept['video/mp4'] = ['.mp4'];
            const handle = await window.showSaveFilePicker({
                suggestedName: filename,
                types: [{ description: 'MP4 video', accept }]
            });
            writable = await handle.createWritable();
        } catch (error) {
            if (error.name === 'AbortError') return;
            throw error;
        }
    }

    // eslint-disable-next-line compat/compat -- This custom download action targets current desktop browsers.
    const controller = new AbortController();
    const dialog = document.createElement('dialog');
    dialog.style.maxWidth = '32em';
    dialog.style.padding = '1.5em';
    const title = document.createElement('h2');
    title.textContent = 'Preparing offline download';
    const progress = document.createElement('p');
    progress.textContent = selection.subtitleMode === 'burn' ? 'Transcoding with permanently visible subtitles. Keep this page open.' : 'Transcoding the selected audio and subtitle tracks. Keep this page open.';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel download';
    cancel.className = 'emby-button raised';
    cancel.addEventListener('click', () => controller.abort());
    dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        controller.abort();
    });
    dialog.append(title, progress, cancel);
    document.body.appendChild(dialog);
    dialog.showModal();

    let reader;
    try {
        const response = await fetch(makeOfflineUrl(apiClient, item.Id, quality, selection), {
            ...authenticatedOptions(apiClient),
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`Offline download failed (HTTP ${response.status}).`);
        if (!response.body) throw new Error('This browser does not support streamed downloads.');
        if (!/^video\/mp4(?:;|$)/i.test(response.headers.get('Content-Type') || '')) {
            throw new Error('The server did not return an MP4 file.');
        }
        reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            bytes += result.value.byteLength;
            if (!writable && bytes > MAX_BUFFERED_BYTES) {
                throw new Error('This HTTP browser download exceeds the 1 GiB memory-buffer limit. Use a smaller quality preset or HTTPS with direct-to-disk support.');
            }
            if (writable) await writable.write(result.value);
            else chunks.push(result.value);
            progress.textContent = `${(bytes / (1024 * 1024)).toFixed(1)} MiB received. Keep this page open until completion.`;
        }
        if (bytes === 0) throw new Error('The server returned an empty download.');
        if (writable) {
            await writable.close();
            writable = undefined;
        } else {
            const blob = new Blob(chunks, { type: 'video/mp4' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            // Give the browser time to consume the local blob URL.
            setTimeout(() => URL.revokeObjectURL(url), 60000);
        }
    } catch (error) {
        controller.abort();
        if (reader) await reader.cancel().catch(() => { /* The request signal may have already cancelled it. */ });
        if (writable) await writable.abort().catch(() => { /* The writable may have already closed. */ });
        if (error.name !== 'AbortError') throw error;
    } finally {
        dialog.close();
        dialog.remove();
    }
}
