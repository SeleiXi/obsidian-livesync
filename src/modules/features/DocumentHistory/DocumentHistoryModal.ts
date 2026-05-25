/* global PouchDB */

import { TFile, Modal, App, DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, diff_match_patch, setIcon } from "../../../deps.ts";
import { getPathFromTFile, isValidPath } from "../../../common/utils.ts";
import { decodeBinary, readString } from "../../../lib/src/string_and_binary/convert.ts";
import ObsidianLiveSyncPlugin from "../../../main.ts";
import {
    type DocumentID,
    type EntryDoc,
    type FilePathWithPrefix,
    type LoadedEntry,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    REMOTE_COUCHDB,
    type RemoteDBSettings,
} from "../../../lib/src/common/types.ts";
import { Logger } from "../../../lib/src/common/logger.ts";
import { isErrorOfMissingDoc } from "../../../lib/src/pouchdb/utils_couchdb.ts";
import { fireAndForget, getDocData, readContent } from "../../../lib/src/common/utils.ts";
import { isPlainText, stripPrefix } from "../../../lib/src/string_and_binary/path.ts";
import { scheduleOnceIfDuplicated } from "octagonal-wheels/concurrency/lock";
import type { LiveSyncBaseCore } from "@/LiveSyncBaseCore.ts";

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
        return new Uint8Array(decodeBinary(w.data));
    }
    if (w.type == "plain" || w.datatype == "plain") return getDocData(w.data);
    if (isComparableTextDecode(w.path)) return readString(new Uint8Array(decodeBinary(w.data)));
    if (isComparableText(w.path)) return getDocData(w.data);
    try {
        return readString(new Uint8Array(decodeBinary(w.data)));
    } catch (ex) {
        Logger(ex, LOG_LEVEL_VERBOSE);
        // NO OP.
    }
    return getDocData(w.data);
}

type RemoteHistoryCapableReplicator = {
    connectRemoteCouchDBWithSetting?: (
        settings: RemoteDBSettings,
        isMobile: boolean,
        performSetup?: boolean,
        skipInfo?: boolean
    ) => Promise<string | { db: PouchDB.Database<EntryDoc> }>;
};

type LocalStorageCapableApp = App & {
    loadLocalStorage?: (key: string) => string | null;
    saveLocalStorage?: (key: string, value: string | null) => void | Promise<void>;
};

const HISTORY_DISPLAY_REVISION_LIMIT = 100;
const HISTORY_BACKFILL_BATCH_SIZE = 100;

export class DocumentHistoryModal extends Modal {
    plugin: ObsidianLiveSyncPlugin;
    core: LiveSyncBaseCore;
    get services() {
        return this.core.services;
    }
    range!: HTMLInputElement;
    contentView!: HTMLDivElement;
    info!: HTMLDivElement;
    fileInfo!: HTMLDivElement;
    showDiff = false;
    diffOnly = false;
    id?: DocumentID;

    file: FilePathWithPrefix;

    revs_info: PouchDB.Core.RevisionInfo[] = [];
    currentDoc?: LoadedEntry;
    currentText = "";
    currentDeleted = false;
    initialRev?: string;

    // Diff navigation state
    currentDiffIndex = -1;
    diffNavContainer!: HTMLDivElement;
    diffNavIndicator!: HTMLSpanElement;
    diffOnlyLabel!: HTMLLabelElement;

    // Search state
    searchKeyword = "";
    searchResults: { rev: string; index: number; matchType: "Content" | "Diff" }[] = [];
    currentSearchIndex = -1;
    searchResultIndicator!: HTMLSpanElement;
    searchProgressIndicator!: HTMLSpanElement;
    searchTimeout: number | null = null;

    // Modal enlargement state
    isLarge = false;
    enlargeBtn!: HTMLElement;

    constructor(
        app: App,
        core: LiveSyncBaseCore,
        plugin: ObsidianLiveSyncPlugin,
        file: TFile | FilePathWithPrefix,
        id?: DocumentID,
        revision?: string
    ) {
        super(app);
        this.plugin = plugin;
        this.core = core;
        this.file = file instanceof TFile ? getPathFromTFile(file) : file;
        this.id = id;
        this.initialRev = revision;
        if (!file && id) {
            this.file = this.services.path.id2path(id);
        }
        if (this.loadHistorySetting("ols-history-highlightdiff") == "1") {
            this.showDiff = true;
        }
        if (this.loadHistorySetting("ols-history-diffonly") == "1") {
            this.diffOnly = true;
        }
    }

    loadHistorySetting(key: string): string | null {
        const loadLocalStorage = (this.app as LocalStorageCapableApp)["loadLocalStorage"];
        if (loadLocalStorage) return loadLocalStorage.call(this.app, key);
        return window.localStorage.getItem(key);
    }

    saveHistorySetting(key: string, value: string | null): void {
        const saveLocalStorage = (this.app as LocalStorageCapableApp)["saveLocalStorage"];
        if (saveLocalStorage) {
            void saveLocalStorage.call(this.app, key, value);
            return;
        }
        if (value == null) {
            window.localStorage.removeItem(key);
            return;
        }
        window.localStorage.setItem(key, value);
    }

    async loadFile(initialRev?: string) {
        if (!this.id) {
            this.id = await this.services.path.path2id(this.file);
        }
        const db = this.core.localDatabase;
        try {
            await this.backfillRemoteHistory();
            const w = await db.getRaw(this.id, { revs_info: true });
            this.revs_info = this.pickDisplayRevisions(w._revs_info);
            this.range.max = `${Math.max(this.revs_info.length - 1, 0)}`;
            this.range.value = this.range.max;
            this.fileInfo.setText(
                `${this.file} / ${this.revs_info.length}${this.revs_info.length == HISTORY_DISPLAY_REVISION_LIMIT ? " latest" : ""} revisions`
            );
            await this.loadRevs(initialRev);
        } catch (ex) {
            if (isErrorOfMissingDoc(ex)) {
                this.range.max = "0";
                this.range.value = "";
                this.range.disabled = true;
                this.contentView.setText(`We don't have any history for this note.`);
            } else {
                this.contentView.setText(`Error while loading file.`);
                Logger(ex, LOG_LEVEL_VERBOSE);
            }
        }
    }

    pickDisplayRevisions(revsInfo: PouchDB.Core.RevisionInfo[] | undefined): PouchDB.Core.RevisionInfo[] {
        return (revsInfo ?? []).filter((e) => e?.status == "available").slice(0, HISTORY_DISPLAY_REVISION_LIMIT);
    }

    async backfillRemoteHistory(): Promise<void> {
        if (!this.id) return;

        const settings = this.services.setting.currentSettings();
        if (settings.remoteType !== REMOTE_COUCHDB || !settings.isConfigured) return;

        const replicator = this.services.replicator.getActiveReplicator() as RemoteHistoryCapableReplicator | undefined;
        if (!replicator?.connectRemoteCouchDBWithSetting) return;

        try {
            const localDoc = await this.core.localDatabase.getRaw<EntryDoc>(this.id, {
                revs_info: true,
                conflicts: true,
            });
            const localAvailable = new Set(
                (localDoc._revs_info ?? []).filter((e) => e.status == "available").map((e) => e.rev)
            );

            const connection = await replicator.connectRemoteCouchDBWithSetting(
                settings,
                this.services.API.isMobile(),
                false,
                true
            );
            if (typeof connection === "string") {
                Logger(`Could not connect remote database for history backfill: ${connection}`, LOG_LEVEL_VERBOSE);
                return;
            }

            const remoteDoc = await connection.db.get(this.id, { revs_info: true, conflicts: true });
            const remoteCurrentRev = remoteDoc._rev;
            if (!remoteCurrentRev || !localAvailable.has(remoteCurrentRev)) {
                Logger(
                    `Skipped remote history backfill for ${this.file}; local and remote heads differ.`,
                    LOG_LEVEL_VERBOSE
                );
                return;
            }

            const remoteAvailableRevs = this.pickDisplayRevisions(remoteDoc._revs_info).map((e) => e.rev);
            const missingRevs = remoteAvailableRevs.filter((rev) => !localAvailable.has(rev));
            if (missingRevs.length == 0) return;

            this.fileInfo.setText(
                `${this.file} / loading ${missingRevs.length} remote revisions for latest history...`
            );
            let restored = 0;
            for (let i = 0; i < missingRevs.length; i += HISTORY_BACKFILL_BATCH_SIZE) {
                const batch = missingRevs.slice(i, i + HISTORY_BACKFILL_BATCH_SIZE);
                const fetched = await connection.db.bulkGet({
                    docs: batch.map((rev) => ({ id: this.id!, rev })),
                    revs: true,
                });
                const docs = fetched.results
                    .flatMap((result) => result.docs)
                    .filter((result): result is { ok: EntryDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta } => {
                        return "ok" in result;
                    })
                    .map((result) => result.ok);
                if (docs.length == 0) continue;

                await this.core.localDatabase.bulkDocsRaw(docs, { new_edits: false });
                restored += docs.length;
            }
            if (restored > 0) {
                Logger(
                    `Backfilled ${restored} remote history revision(s) for ${this.file} within latest ${HISTORY_DISPLAY_REVISION_LIMIT}`,
                    LOG_LEVEL_INFO
                );
            }
        } catch (ex) {
            Logger(`Could not backfill remote history for ${this.file}`, LOG_LEVEL_VERBOSE);
            Logger(ex, LOG_LEVEL_VERBOSE);
        }
    }

    async loadRevs(initialRev?: string) {
        if (this.revs_info.length == 0) return;
        if (initialRev) {
            const rIndex = this.revs_info.findIndex((e) => e.rev == initialRev);
            if (rIndex >= 0) {
                this.range.value = `${this.revs_info.length - 1 - rIndex}`;
            }
        }
        const index = this.revs_info.length - 1 - (this.range.value as any) / 1;
        const rev = this.revs_info[index];
        await this.showExactRev(rev.rev);
    }
    BlobURLs = new Map<string, string>();

    revokeURL(key: string) {
        const v = this.BlobURLs.get(key);
        if (v) {
            URL.revokeObjectURL(v);
        }
        this.BlobURLs.delete(key);
    }
    generateBlobURL(key: string, data: Uint8Array<ArrayBuffer>) {
        this.revokeURL(key);
        const v = URL.createObjectURL(new Blob([data], { endings: "transparent", type: "application/octet-stream" }));
        this.BlobURLs.set(key, v);
        return v;
    }

    prepareContentView(usePreformatted = true) {
        this.contentView.empty();
        this.contentView.toggleClass("op-pre", usePreformatted);
    }

    appendTextDiff(diff: [number, string][]) {
        let hasOmitted = false;
        for (const [operation, text] of diff) {
            if (operation == DIFF_DELETE) {
                this.appendSearchHighlightedText(this.contentView.createSpan({ cls: "history-deleted" }), text);
                hasOmitted = false;
            } else if (operation == DIFF_EQUAL) {
                if (this.diffOnly) {
                    if (!hasOmitted) {
                        this.contentView.appendText("\n...\n");
                        hasOmitted = true;
                    }
                } else {
                    this.appendSearchHighlightedText(this.contentView.createSpan({ cls: "history-normal" }), text);
                }
            } else if (operation == DIFF_INSERT) {
                this.appendSearchHighlightedText(this.contentView.createSpan({ cls: "history-added" }), text);
                hasOmitted = false;
            }
        }
    }

    appendSearchHighlightedText(container: HTMLElement, text: string) {
        if (!this.searchKeyword) {
            container.appendText(text);
            return;
        }
        const escapedKeyword = this.searchKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(escapedKeyword, "gi");
        let lastIndex = 0;
        for (const match of text.matchAll(regex)) {
            const index = match.index ?? 0;
            if (index > lastIndex) {
                container.appendText(text.slice(lastIndex, index));
            }
            container.createEl("mark", { text: match[0] });
            lastIndex = index + match[0].length;
        }
        if (lastIndex < text.length) {
            container.appendText(text.slice(lastIndex));
        }
    }

    appendImageDiff(baseSrc: string, overlaySrc?: string) {
        const wrap = this.contentView.createDiv({ cls: "ls-imgdiff-wrap" });
        const overlay = wrap.createDiv({ cls: "overlay" });
        overlay.createEl("img", { cls: "img-base" }, (img) => {
            img.src = baseSrc;
        });
        if (overlaySrc) {
            overlay.createEl("img", { cls: "img-overlay" }, (img) => {
                img.src = overlaySrc;
            });
        }
    }

    appendDeletedNotice(usePreformatted = true) {
        const notice = "(At this revision, the file has been deleted)";
        if (usePreformatted) {
            this.contentView.appendText(`${notice}\n`);
        } else {
            this.contentView.createDiv({ text: notice });
        }
    }

    async showExactRev(rev: string) {
        const db = this.core.localDatabase;
        const w = await db.getDBEntry(this.file, { rev: rev }, false, false, true);
        this.currentText = "";
        this.currentDeleted = false;
        this.prepareContentView();
        if (w === false) {
            this.currentDeleted = true;
            this.info.empty();
            this.contentView.appendText("Could not read this revision");
            this.contentView.createEl("br");
            this.contentView.appendText(`(${rev})`);
        } else {
            this.currentDoc = w;
            this.info.setText(`Modified:${new Date(w.mtime).toLocaleString()}`);
            const w1data = readDocument(w);
            this.currentDeleted = !!w.deleted;
            if (typeof w1data == "string") {
                this.currentText = w1data;
            }
            let rendered = false;
            if (this.showDiff) {
                const prevRevIdx = this.revs_info.length - 1 - ((this.range.value as any) / 1 - 1);
                if (prevRevIdx >= 0 && prevRevIdx < this.revs_info.length) {
                    const oldRev = this.revs_info[prevRevIdx].rev;
                    const w2 = await db.getDBEntry(this.file, { rev: oldRev }, false, false, true);
                    if (w2 != false) {
                        if (typeof w1data == "string") {
                            const w2data = readDocument(w2);
                            if (typeof w2data == "string") {
                                const dmp = new diff_match_patch();
                                const diff = dmp.diff_main(w2data, w1data);
                                dmp.diff_cleanupSemantic(diff);
                                if (this.currentDeleted) {
                                    this.appendDeletedNotice();
                                }
                                this.appendTextDiff(diff);
                                rendered = true;
                            }
                        } else if (isImage(this.file)) {
                            const src = this.generateBlobURL("base", w1data);
                            const overlay = this.generateBlobURL(
                                "overlay",
                                readDocument(w2) as Uint8Array<ArrayBuffer>
                            );
                            this.prepareContentView(false);
                            if (this.currentDeleted) {
                                this.appendDeletedNotice(false);
                            }
                            this.appendImageDiff(src, overlay);
                            rendered = true;
                        }
                    }
                }
            }
            if (!rendered) {
                if (typeof w1data != "string") {
                    if (isImage(this.file)) {
                        const src = this.generateBlobURL("base", w1data);
                        this.prepareContentView(false);
                        if (this.currentDeleted) {
                            this.appendDeletedNotice(false);
                        }
                        this.appendImageDiff(src);
                    } else {
                        if (this.currentDeleted) {
                            this.appendDeletedNotice();
                        }
                        this.contentView.appendText("Binary file");
                    }
                } else {
                    if (this.currentDeleted) {
                        this.appendDeletedNotice();
                    }
                    this.appendSearchHighlightedText(this.contentView, w1data);
                }
            }
        }
        // Reset diff navigation after content changes
        this.resetDiffNavigation();
        if (this.showDiff) {
            this.navigateDiff("next");
        } else if (this.searchKeyword) {
            const firstMark = this.contentView.querySelector("mark");
            if (firstMark) {
                firstMark.scrollIntoView({ behavior: "smooth", block: "center" });
            }
        }
    }

    /**
     * Navigate to the previous or next diff block in the content view.
     * Only effective when diff highlighting is enabled.
     */
    navigateDiff(direction: "prev" | "next") {
        const diffElements = this.contentView.querySelectorAll(".history-added, .history-deleted");
        if (diffElements.length === 0) return;

        // Remove previous focus highlight
        const prevFocused = this.contentView.querySelector(".diff-focused");
        if (prevFocused) {
            prevFocused.classList.remove("diff-focused");
        }

        if (direction === "next") {
            this.currentDiffIndex = (this.currentDiffIndex + 1) % diffElements.length;
        } else {
            this.currentDiffIndex = this.currentDiffIndex <= 0 ? diffElements.length - 1 : this.currentDiffIndex - 1;
        }

        const target = diffElements[this.currentDiffIndex];
        target.classList.add("diff-focused");
        target.scrollIntoView({ behavior: "smooth", block: "center" });

        this.diffNavIndicator.setText(`${this.currentDiffIndex + 1}/${diffElements.length}`);
    }

    /**
     * Reset the diff navigation index and update the indicator.
     */
    resetDiffNavigation() {
        this.currentDiffIndex = -1;
        if (this.diffNavIndicator) {
            if (this.showDiff) {
                const diffElements = this.contentView.querySelectorAll(".history-added, .history-deleted");
                this.diffNavIndicator.setText(diffElements.length > 0 ? `0/${diffElements.length}` : "\u2014");
            } else {
                this.diffNavIndicator.setText("\u2014");
            }
        }
        this.updateDiffNavVisibility();
    }

    /**
     * Show or hide the diff navigation buttons based on the showDiff state.
     */
    updateDiffNavVisibility() {
        if (this.diffNavContainer) {
            this.diffNavContainer.style.display = this.showDiff ? "flex" : "none";
        }
        if (this.diffOnlyLabel) {
            this.diffOnlyLabel.style.display = this.showDiff ? "inline-block" : "none";
        }
    }

    /**
     * Search through the last 100 revisions for the given keyword.
     */
    async performSearch(keyword: string) {
        this.searchKeyword = keyword;
        this.searchResults = [];
        this.currentSearchIndex = -1;

        if (!keyword) {
            this.searchResultIndicator.setText("");
            this.searchProgressIndicator.setText("");
            return;
        }

        const db = this.core.localDatabase;
        const limit = HISTORY_DISPLAY_REVISION_LIMIT;
        const totalRevs = this.revs_info.length;
        const end = Math.min(totalRevs, limit);

        this.searchProgressIndicator.setText("Searching...");

        const dmp = new diff_match_patch();

        // 0 is the newest, higher index is older.
        for (let i = 0; i < end; i++) {
            const revInfo = this.revs_info[i];
            const rev = revInfo.rev;

            this.searchProgressIndicator.setText(`Searching ${i + 1}/${end}...`);

            const doc = await db.getDBEntry(this.file, { rev: rev }, false, false, true);
            if (doc === false) continue;

            const content = readDocument(doc);
            if (typeof content !== "string") continue;

            const keywordLower = keyword.toLocaleLowerCase();

            // Search in content
            if (content.toLocaleLowerCase().includes(keywordLower)) {
                this.searchResults.push({ rev, index: i, matchType: "Content" });
                this.updateSearchUI();
                continue;
            }

            // Search in diff (from older version to this version)
            // Older version is at i + 1
            if (i < totalRevs - 1) {
                const olderRev = this.revs_info[i + 1].rev;
                const olderDoc = await db.getDBEntry(this.file, { rev: olderRev }, false, false, true);
                if (olderDoc !== false) {
                    const olderContent = readDocument(olderDoc);
                    if (typeof olderContent === "string") {
                        const diffs = dmp.diff_main(olderContent, content);
                        let foundInDiff = false;
                        for (const d of diffs) {
                            if (
                                (d[0] === DIFF_INSERT || d[0] === DIFF_DELETE) &&
                                d[1].toLocaleLowerCase().includes(keywordLower)
                            ) {
                                foundInDiff = true;
                                break;
                            }
                        }
                        if (foundInDiff) {
                            this.searchResults.push({ rev, index: i, matchType: "Diff" });
                            this.updateSearchUI();
                        }
                    }
                }
            }
        }

        this.searchProgressIndicator.setText("Done");
        this.updateSearchUI();
    }

    updateSearchUI() {
        if (this.searchResults.length === 0) {
            this.searchResultIndicator.setText(this.searchKeyword ? "No matches found" : "");
        } else {
            const current = this.currentSearchIndex >= 0 ? this.currentSearchIndex + 1 : 0;
            this.searchResultIndicator.setText(`${current}/${this.searchResults.length} matches`);
        }
    }

    navigateSearch(direction: "prev" | "next") {
        if (this.searchResults.length === 0) return;

        if (direction === "next") {
            this.currentSearchIndex = (this.currentSearchIndex + 1) % this.searchResults.length;
        } else {
            this.currentSearchIndex =
                this.currentSearchIndex <= 0 ? this.searchResults.length - 1 : this.currentSearchIndex - 1;
        }

        const match = this.searchResults[this.currentSearchIndex];
        this.range.value = `${this.revs_info.length - 1 - match.index}`;
        void scheduleOnceIfDuplicated("loadRevs", () => this.loadRevs());
        this.updateSearchUI();

        // If it's a diff match, make sure Highlight diff is on
        if (match.matchType === "Diff" && !this.showDiff) {
            // We could auto-enable it, but maybe just notify the user?
            // For now, let's just let the user toggle it if they want to see the diff.
        }
    }

    /**
     * Toggles the modal between standard and enlarged size.
     */
    toggleLarge() {
        this.isLarge = !this.isLarge;
        if (this.isLarge) {
            this.modalEl.addClass("modal-large");
            setIcon(this.enlargeBtn, "minimize-2");
            this.enlargeBtn.setAttribute("aria-label", "Shrink");
        } else {
            this.modalEl.removeClass("modal-large");
            setIcon(this.enlargeBtn, "maximize-2");
            this.enlargeBtn.setAttribute("aria-label", "Enlarge");
        }
    }

    override onOpen() {
        const { contentEl } = this;
        this.titleEl.setText("Document History");

        const headerButtons = this.titleEl.parentElement?.createDiv("modal-header-buttons");
        if (headerButtons) {
            this.enlargeBtn = headerButtons.createEl("button", { cls: "modal-header-button" });
            setIcon(this.enlargeBtn, "maximize-2");
            this.enlargeBtn.setAttribute("aria-label", "Enlarge");
            this.enlargeBtn.addEventListener("click", () => this.toggleLarge());
        }

        contentEl.empty();
        this.fileInfo = contentEl.createDiv("");
        this.fileInfo.addClass("op-info");

        // Search Row
        const searchRow = contentEl.createDiv("");
        searchRow.addClass("op-info");
        searchRow.addClass("search-row");
        searchRow.addClass("history-search-row");

        const searchInput = searchRow.createEl("input", {
            type: "text",
            placeholder: "Search in history (last 100)...",
        });
        searchInput.addClass("history-search-input");
        searchInput.addEventListener("input", () => {
            if (this.searchTimeout) {
                window.clearTimeout(this.searchTimeout);
            }
            this.searchTimeout = window.setTimeout(() => {
                void this.performSearch(searchInput.value);
            }, 500);
        });

        searchRow.createEl("button", { text: "\u25B2" }, (e) => {
            e.title = "Previous match";
            e.addEventListener("click", () => this.navigateSearch("prev"));
        });
        searchRow.createEl("button", { text: "\u25BC" }, (e) => {
            e.title = "Next match";
            e.addEventListener("click", () => this.navigateSearch("next"));
        });

        this.searchResultIndicator = searchRow.createEl("span", { text: "" });
        this.searchResultIndicator.addClass("history-search-result-indicator");

        this.searchProgressIndicator = searchRow.createEl("span", { text: "" });
        this.searchProgressIndicator.addClass("history-search-progress-indicator");

        const divView = contentEl.createDiv("");
        divView.addClass("op-flex");

        divView.createEl("input", { type: "range" }, (e) => {
            this.range = e;
            e.addEventListener("change", (e) => {
                void scheduleOnceIfDuplicated("loadRevs", () => this.loadRevs());
            });
            e.addEventListener("input", (e) => {
                void scheduleOnceIfDuplicated("loadRevs", () => this.loadRevs());
            });
        });
        const diffOptionsRow = contentEl.createDiv("");
        diffOptionsRow.addClass("op-info");
        diffOptionsRow.addClass("diff-options-row");
        diffOptionsRow.addClass("history-diff-options-row");

        const highlightDiffContainer = diffOptionsRow.createDiv("");
        highlightDiffContainer.addClass("history-highlight-diff-container");

        highlightDiffContainer.createEl("label", {}, (label) => {
            label.addClass("history-highlight-diff-label");
            label.createEl("input", { type: "checkbox" }, (checkbox) => {
                if (this.showDiff) {
                    checkbox.checked = true;
                }
                checkbox.addEventListener("input", (evt: any) => {
                    this.showDiff = checkbox.checked;
                    this.saveHistorySetting("ols-history-highlightdiff", this.showDiff == true ? "1" : null);
                    this.updateDiffNavVisibility();
                    void scheduleOnceIfDuplicated("loadRevs", () => this.loadRevs());
                });
            });
            label.appendText("Highlight diff");
        });

        const diffOnlyLabel = diffOptionsRow.createEl("label", {});
        diffOnlyLabel.createEl("input", { type: "checkbox" }, (checkbox) => {
            if (this.diffOnly) {
                checkbox.checked = true;
            }
            checkbox.addEventListener("input", (evt: any) => {
                this.diffOnly = checkbox.checked;
                this.saveHistorySetting("ols-history-diffonly", this.diffOnly == true ? "1" : null);
                void scheduleOnceIfDuplicated("loadRevs", () => this.loadRevs());
            });
        });
        diffOnlyLabel.appendText("Diff only");
        diffOnlyLabel.addClass("diff-only-label");
        diffOnlyLabel.style.display = this.showDiff ? "inline-block" : "none";
        this.diffOnlyLabel = diffOnlyLabel;

        // Diff navigation buttons
        this.diffNavContainer = diffOptionsRow.createDiv("");
        this.diffNavContainer.addClass("diff-nav");
        this.diffNavContainer.style.display = this.showDiff ? "flex" : "none";

        this.diffNavContainer.createEl("button", { text: "\u25B2 Prev" }, (e) => {
            e.addClass("diff-nav-btn");
            e.addEventListener("click", () => {
                this.navigateDiff("prev");
            });
        });
        this.diffNavContainer.createEl("button", { text: "\u25BC Next" }, (e) => {
            e.addClass("diff-nav-btn");
            e.addEventListener("click", () => {
                this.navigateDiff("next");
            });
        });
        this.diffNavIndicator = this.diffNavContainer.createEl("span", { text: "\u2014" });
        this.diffNavIndicator.addClass("diff-nav-indicator");

        this.info = contentEl.createDiv("");
        this.info.addClass("op-info");
        fireAndForget(async () => await this.loadFile(this.initialRev));
        const div = contentEl.createDiv({ text: "Loading old revisions..." });
        this.contentView = div;
        div.addClass("op-scrollable");
        div.addClass("op-pre");
        const buttons = contentEl.createDiv("");
        buttons.createEl("button", { text: "Copy to clipboard" }, (e) => {
            e.addClass("mod-cta");
            e.addEventListener("click", () => {
                fireAndForget(async () => {
                    await navigator.clipboard.writeText(this.currentText);
                    Logger(`Old content copied to clipboard`, LOG_LEVEL_NOTICE);
                });
            });
        });
        const focusFile = async (path: string) => {
            const targetFile = this.plugin.app.vault.getFileByPath(path);
            if (targetFile) {
                const leaf = this.plugin.app.workspace.getLeaf(false);
                await leaf.openFile(targetFile);
            } else {
                Logger("Unable to display the file in the editor", LOG_LEVEL_NOTICE);
            }
        };
        buttons.createEl("button", { text: "Back to this revision" }, (e) => {
            e.addClass("mod-cta");
            e.addEventListener("click", () => {
                fireAndForget(async () => {
                    // const pathToWrite = this.plugin.id2path(this.id, true);
                    const pathToWrite = stripPrefix(this.file);
                    if (!isValidPath(pathToWrite)) {
                        Logger("Path is not valid to write content.", LOG_LEVEL_INFO);
                        return;
                    }
                    if (!this.currentDoc) {
                        Logger("No active file loaded.", LOG_LEVEL_INFO);
                        return;
                    }
                    const d = readContent(this.currentDoc);
                    await this.core.storageAccess.writeHiddenFileAuto(pathToWrite, d);
                    await focusFile(pathToWrite);
                    this.close();
                });
            });
        });
    }
    override onClose() {
        const { contentEl } = this;
        contentEl.empty();
        this.BlobURLs.forEach((value) => {
            console.log(value);
            if (value) URL.revokeObjectURL(value);
        });
    }
}
