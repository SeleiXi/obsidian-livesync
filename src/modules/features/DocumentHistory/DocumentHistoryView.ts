import { WorkspaceLeaf } from "../../../deps.ts";
import DocumentHistoryComponent from "./DocumentHistory.svelte";
import type ObsidianLiveSyncPlugin from "../../../main.ts";
import { SvelteItemView } from "../../../common/SvelteItemView.ts";
import { mount } from "svelte";
import type { FilePathWithPrefix } from "../../../lib/src/common/types.ts";

export const VIEW_TYPE_DOCUMENT_HISTORY_SVELTE = "document-history-svelte";

export class DocumentHistoryView extends SvelteItemView {
    plugin: ObsidianLiveSyncPlugin;
    file: FilePathWithPrefix | null = null;
    override icon = "clock";
    title: string = "Document History (Svelte)";
    override navigation = true;

    constructor(leaf: WorkspaceLeaf, plugin: ObsidianLiveSyncPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    override getIcon(): string {
        return "clock";
    }

    getViewType() {
        return VIEW_TYPE_DOCUMENT_HISTORY_SVELTE;
    }

    getDisplayText() {
        return "Document History";
    }

    override async setState(state: any, result: any) {
        const previousFile = this.file;
        if (state.file) {
            this.file = state.file as FilePathWithPrefix;
            this.title = `History: ${this.file.split('/').pop()}`;
        }
        await super.setState(state, result);
        if (this.component && previousFile !== this.file) {
            await this._dismountComponent();
            this.contentEl.empty();
            this.component = await this.instantiateComponent(this.contentEl);
        }
    }

    instantiateComponent(target: HTMLElement) {
        if (!this.file) {
            target.setText("No file selected.");
            return undefined as any;
        }

        return mount(DocumentHistoryComponent, {
            target: target,
            props: {
                plugin: this.plugin,
                core: this.plugin.core,
                file: this.file,
            },
        });
    }
}
