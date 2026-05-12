<script lang="ts">
    import ObsidianLiveSyncPlugin from "../../../main.ts";
    import { onMount, onDestroy, tick } from "svelte";
    import type { DocumentID, FilePathWithPrefix, LoadedEntry } from "../../../lib/src/common/types.ts";
    import { getPathFromTFile, isValidPath } from "../../../common/utils.ts";
    import { decodeBinary, escapeStringToHTML, readString } from "../../../lib/src/string_and_binary/convert.ts";
    import { isErrorOfMissingDoc } from "../../../lib/src/pouchdb/utils_couchdb.ts";
    import { fireAndForget, getDocData, readContent } from "../../../lib/src/common/utils.ts";
    import { isPlainText, stripPrefix } from "../../../lib/src/string_and_binary/path.ts";
    import { Logger } from "../../../lib/src/common/logger.ts";
    import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, diff_match_patch, TFile } from "../../../deps.ts";
    import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "../../../lib/src/common/types.ts";
    import type { LiveSyncBaseCore } from "@/LiveSyncBaseCore.ts";

    export let plugin: ObsidianLiveSyncPlugin;
    export let core: LiveSyncBaseCore;
    export let file: FilePathWithPrefix;

    let mergeWithinOneMinute = false;
    let showDiff = false;
    let loading = true;
    let error = "";

    // Extracted helpers from DocumentHistoryModal
    function isImage(path: string) {
        const ext = path.split(".").splice(-1)[0].toLowerCase();
        return ["png", "jpg", "jpeg", "gif", "bmp", "webp"].includes(ext);
    }
    function isComparableText(path: string) {
        const ext = path.split(".").splice(-1)[0].toLowerCase();
        return isPlainText(path) || ["md", "mdx", "txt", "json"].includes(ext);
    }
    function isComparableTextDecode(path: string) {
        const ext = path.split(".").splice(-1)[0].toLowerCase();
        return ["json"].includes(ext);
    }
    function readDocument(w: LoadedEntry) {
        if (w.data.length == 0) return "";
        if (isImage(w.path)) {
            return new Uint8Array(decodeBinary(w.data as any));
        }
        if (w.type == "plain" || w.datatype == "plain") return getDocData(w.data);
        if (isComparableTextDecode(w.path)) return readString(new Uint8Array(decodeBinary(w.data as any)));
        if (isComparableText(w.path)) return getDocData(w.data);
        try {
            return readString(new Uint8Array(decodeBinary(w.data as any)));
        } catch (ex) {
            Logger(ex, LOG_LEVEL_VERBOSE);
        }
        return getDocData(w.data);
    }

    type RevisionData = {
        rev: string;
        mtime: number;
        mtimeDisp: string;
        isDeleted: boolean;
        doc?: LoadedEntry;
    };

    type RevisionGroup = {
        id: string;
        revisions: RevisionData[];
        representative: RevisionData; // Usually the latest one
        mtime: number;
        mtimeDisp: string;
        count: number;
    };

    let allRevisions: RevisionData[] = [];
    let displayedGroups: RevisionGroup[] = [];
    let selectedGroup: RevisionGroup | null = null;

    let currentContentHtml = "";
    let currentText = "";

    async function loadHistory() {
        loading = true;
        error = "";
        try {
            const db = core.localDatabase;
            const id = await core.services.path.path2id(file);
            const w = await db.getRaw(id, { revs_info: true });
            const revs_info = w._revs_info?.filter((e) => e?.status == "available") ?? [];

            const fetchedRevs: RevisionData[] = [];

            // For efficiency, we should ideally fetch bulk, but PouchDB bulkGet might be tricky for all revs
            // Let's fetch them one by one like the modal, or use bulkGet if possible.
            // Actually, fetching all documents might be slow for huge histories.
            // Let's do bulkGet for metadata if possible, or just Promise.all in batches.
            const batchSize = 10;
            for (let i = 0; i < revs_info.length; i += batchSize) {
                const batch = revs_info.slice(i, i + batchSize);
                const promises = batch.map(async (revInfo) => {
                    const doc = await db.getDBEntry(file, { rev: revInfo.rev }, false, false, true);
                    if (doc !== false) {
                        return {
                            rev: revInfo.rev,
                            mtime: doc.mtime || 0,
                            mtimeDisp: new Date(doc.mtime || 0).toLocaleString(),
                            isDeleted: !!(doc.deleted || (doc as any)._deleted),
                            doc: doc
                        };
                    }
                    return null;
                });
                const results = await Promise.all(promises);
                for (const r of results) {
                    if (r) fetchedRevs.push(r);
                }
            }

            // Sort descending by mtime
            fetchedRevs.sort((a, b) => b.mtime - a.mtime);
            allRevisions = fetchedRevs;

            updateGroups();

            if (displayedGroups.length > 0) {
                selectGroup(displayedGroups[0]);
            }
        } catch (ex) {
            if (isErrorOfMissingDoc(ex)) {
                error = "We don't have any history for this note.";
            } else {
                error = "Error while loading file.";
                Logger(ex, LOG_LEVEL_VERBOSE);
            }
        } finally {
            loading = false;
        }
    }

    function updateGroups() {
        if (!mergeWithinOneMinute) {
            displayedGroups = allRevisions.map(r => ({
                id: r.rev,
                revisions: [r],
                representative: r,
                mtime: r.mtime,
                mtimeDisp: r.mtimeDisp,
                count: 1
            }));
            return;
        }

        const groups: RevisionGroup[] = [];
        let currentGroup: RevisionData[] = [];

        // allRevisions are sorted newest to oldest
        // But to group by time, it's easier to iterate oldest to newest, or just group sequentially
        const reversed = [...allRevisions].reverse();

        for (const rev of reversed) {
            if (currentGroup.length === 0) {
                currentGroup.push(rev);
            } else {
                const prevRev = currentGroup[currentGroup.length - 1];
                if (Math.abs(rev.mtime - prevRev.mtime) <= 60000) { // 1 minute
                    currentGroup.push(rev);
                } else {
                    const representative = currentGroup[currentGroup.length - 1]; // latest in group
                    groups.push({
                        id: representative.rev,
                        revisions: [...currentGroup].reverse(), // keep newest first inside group
                        representative: representative,
                        mtime: representative.mtime,
                        mtimeDisp: representative.mtimeDisp,
                        count: currentGroup.length
                    });
                    currentGroup = [rev];
                }
            }
        }

        if (currentGroup.length > 0) {
            const representative = currentGroup[currentGroup.length - 1];
            groups.push({
                id: representative.rev,
                revisions: [...currentGroup].reverse(),
                representative: representative,
                mtime: representative.mtime,
                mtimeDisp: representative.mtimeDisp,
                count: currentGroup.length
            });
        }

        // Reverse back to newest first
        displayedGroups = groups.reverse();

        // Ensure selected group is still valid
        if (selectedGroup) {
            const stillExists = displayedGroups.find(g => g.id === selectedGroup?.id);
            if (!stillExists && displayedGroups.length > 0) {
                selectGroup(displayedGroups[0]);
            } else if (stillExists) {
                selectGroup(stillExists);
            }
        }
    }

    $: mergeWithinOneMinute, showDiff, updateGroups(), reRenderContent();

    let BlobURLs = new Map<string, string>();
    function revokeURL(key: string) {
        const v = BlobURLs.get(key);
        if (v) {
            URL.revokeObjectURL(v);
        }
        BlobURLs.delete(key);
    }
    function generateBlobURL(key: string, data: Uint8Array<ArrayBuffer>) {
        revokeURL(key);
        const v = URL.createObjectURL(new Blob([data], { endings: "transparent", type: "application/octet-stream" }));
        BlobURLs.set(key, v);
        return v;
    }

    onDestroy(() => {
        BlobURLs.forEach((value) => {
            if (value) URL.revokeObjectURL(value);
        });
    });

    async function reRenderContent() {
        if (!selectedGroup) {
            currentContentHtml = "";
            return;
        }

        const currentRevData = selectedGroup.representative;
        const w1 = currentRevData.doc;
        if (!w1) return;

        const w1data = readDocument(w1);
        currentText = typeof w1data === "string" ? w1data : "";
        let result: string | undefined = undefined;

        if (showDiff) {
            // Find previous group's representative
            const groupIdx = displayedGroups.findIndex(g => g.id === selectedGroup!.id);
            if (groupIdx >= 0 && groupIdx + 1 < displayedGroups.length) {
                const prevRevData = displayedGroups[groupIdx + 1].representative;
                const w2 = prevRevData.doc;
                if (w2) {
                    if (typeof w1data == "string") {
                        result = "";
                        const dmp = new diff_match_patch();
                        const w2data = readDocument(w2) as string;
                        const diff = dmp.diff_main(w2data, w1data);
                        dmp.diff_cleanupSemantic(diff);
                        for (const v of diff) {
                            const x1 = v[0];
                            const x2 = v[1];
                            if (x1 == DIFF_DELETE) {
                                result += "<span class='history-deleted'>" + escapeStringToHTML(x2) + "</span>";
                            } else if (x1 == DIFF_EQUAL) {
                                result += "<span class='history-normal'>" + escapeStringToHTML(x2) + "</span>";
                            } else if (x1 == DIFF_INSERT) {
                                result += "<span class='history-added'>" + escapeStringToHTML(x2) + "</span>";
                            }
                        }
                        result = result.replace(/\n/g, "<br>");
                    } else if (isImage(file)) {
                        const src = generateBlobURL("base", w1data as any);
                        const overlay = generateBlobURL("overlay", readDocument(w2) as Uint8Array<ArrayBuffer>);
                        result = `<div class='ls-imgdiff-wrap'>
                            <div class='overlay'>
                                <img class='img-base' src="${src}">
                                <img class='img-overlay' src='${overlay}'>
                            </div>
                        </div>`;
                    }
                }
            }
        }

        if (result === undefined) {
            if (typeof w1data != "string") {
                if (isImage(file)) {
                    const src = generateBlobURL("base", w1data as any);
                    result = `<div class='ls-imgdiff-wrap'>
                        <div class='overlay'>
                        <img class='img-base' src="${src}">
                        </div>
                    </div>`;
                }
            } else {
                result = escapeStringToHTML(w1data);
            }
        }

        if (result === undefined) result = typeof w1data == "string" ? escapeStringToHTML(w1data) : "Binary file";

        currentContentHtml = (currentRevData.isDeleted ? "(At this revision, the file has been deleted)\n" : "") + result;
    }

    function selectGroup(group: RevisionGroup) {
        selectedGroup = group;
        reRenderContent();
    }

    async function copyToClipboard() {
        await navigator.clipboard.writeText(currentText);
        Logger(`Old content copied to clipboard`, LOG_LEVEL_NOTICE);
    }

    async function focusFile(path: string) {
        const targetFile = plugin.app.vault.getFileByPath(path);
        if (targetFile) {
            const leaf = plugin.app.workspace.getLeaf(false);
            await leaf.openFile(targetFile);
        } else {
            Logger("Unable to display the file in the editor", LOG_LEVEL_NOTICE);
        }
    }

    async function restoreRevision() {
        const pathToWrite = stripPrefix(file);
        if (!isValidPath(pathToWrite)) {
            Logger("Path is not valid to write content.", LOG_LEVEL_INFO);
            return;
        }
        if (!selectedGroup || !selectedGroup.representative.doc) {
            Logger("No active file loaded.", LOG_LEVEL_INFO);
            return;
        }
        const d = readContent(selectedGroup.representative.doc);
        await core.storageAccess.writeHiddenFileAuto(pathToWrite, d);
        await focusFile(pathToWrite);
        Logger(`Restored revision ${selectedGroup.representative.rev}`, LOG_LEVEL_NOTICE);
    }

    onMount(() => {
        loadHistory();
    });

</script>

<div class="document-history-svelte">
    <div class="header">
        <h2>Document History</h2>
        <div class="file-info">{file}</div>

        <div class="controls">
            <label>
                <input type="checkbox" bind:checked={mergeWithinOneMinute} />
                Merge modifications within one minute
            </label>
            <label>
                <input type="checkbox" bind:checked={showDiff} />
                Highlight diff
            </label>
        </div>
    </div>

    {#if loading}
        <div class="loading">Loading revisions...</div>
    {:else if error}
        <div class="error">{error}</div>
    {:else}
        <div class="main-content">
            <div class="sidebar">
                <div class="revision-list">
                    {#each displayedGroups as group}
                        <!-- svelte-ignore a11y-click-events-have-key-events -->
                        <!-- svelte-ignore a11y-no-static-element-interactions -->
                        <div class="revision-item"
                             class:selected={selectedGroup?.id === group.id}
                             on:click={() => selectGroup(group)}>
                            <div class="rev-time">{group.mtimeDisp}</div>
                            <div class="rev-id">
                                {group.representative.rev.substring(0, 8)}...
                                {#if group.count > 1}
                                    <span class="badge">+{group.count - 1}</span>
                                {/if}
                                {#if group.representative.isDeleted}
                                    <span class="deleted-icon">🗑️</span>
                                {/if}
                            </div>
                        </div>
                    {/each}
                </div>
            </div>
            <div class="content-view">
                <div class="content-actions">
                    {#if selectedGroup}
                        <span>{selectedGroup.mtimeDisp}</span>
                        <button on:click={copyToClipboard}>Copy to clipboard</button>
                        <button on:click={restoreRevision}>Back to this revision</button>
                    {/if}
                </div>
                <div class="content-html op-pre">
                    {@html currentContentHtml}
                </div>
            </div>
        </div>
    {/if}
</div>

<style>
    .document-history-svelte {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }
    .header {
        padding: 10px;
        border-bottom: 1px solid var(--background-modifier-border);
    }
    .header h2 {
        margin: 0 0 5px 0;
    }
    .file-info {
        font-size: 0.9em;
        color: var(--text-muted);
        margin-bottom: 10px;
    }
    .controls {
        display: flex;
        gap: 15px;
    }
    .main-content {
        display: flex;
        flex: 1;
        overflow: hidden;
    }
    .sidebar {
        width: 250px;
        border-right: 1px solid var(--background-modifier-border);
        overflow-y: auto;
    }
    .revision-list {
        display: flex;
        flex-direction: column;
    }
    .revision-item {
        padding: 10px;
        cursor: pointer;
        border-bottom: 1px solid var(--background-modifier-border-hover);
    }
    .revision-item:hover {
        background-color: var(--background-modifier-hover);
    }
    .revision-item.selected {
        background-color: var(--background-modifier-active-hover);
        border-left: 3px solid var(--interactive-accent);
    }
    .rev-time {
        font-weight: bold;
        font-size: 0.9em;
    }
    .rev-id {
        font-size: 0.8em;
        color: var(--text-muted);
        display: flex;
        align-items: center;
        gap: 5px;
    }
    .badge {
        background-color: var(--interactive-accent);
        color: var(--text-on-accent);
        border-radius: 4px;
        padding: 2px 5px;
        font-size: 0.9em;
    }
    .content-view {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .content-actions {
        padding: 10px;
        display: flex;
        gap: 10px;
        align-items: center;
        border-bottom: 1px solid var(--background-modifier-border);
    }
    .content-html {
        flex: 1;
        overflow: auto;
        padding: 10px;
        white-space: pre-wrap;
        word-break: break-all;
    }
</style>
