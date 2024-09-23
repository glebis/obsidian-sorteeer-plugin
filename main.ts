import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, MarkdownRenderer, SuggestModal, TAbstractFile, TextComponent } from 'obsidian';
import { fetchUrlContent, extractUnlinkedUrls } from './url_fetcher';

interface SorteeerSettings {
	sortFolder: string;
	sortOrder: 'random' | 'oldest' | 'newest' | 'smallest';
	deleteAction: string;
	moveAction: string;
	removeTagAction: string;
	addTagAction: string;
	addLinkAction: string;
	seeAlsoHeader: string;
	dailyNoteFormat: string;
	dailyNoteFolder: string;
	dailyNoteSection: string;
	showNotifications: boolean;
	urlFetchFields: string[];
	groqApiKey: string;
	groqModel: string;
	outputImages: boolean;
	fileRenamingPrompt: string;
}

interface DeletedNote {
	file: TFile;
	content: string;
}

class FolderSuggest {
    app: App;
    inputEl: HTMLInputElement;

    constructor(app: App, inputEl: HTMLInputElement) {
        this.app = app;
        this.inputEl = inputEl;
    }

    getSuggestions(inputStr: string): TFolder[] {
        const abstractFiles = this.app.vault.getAllLoadedFiles();
        const folders: TFolder[] = [];
        const lowerCaseInputStr = inputStr.toLowerCase();

        abstractFiles.forEach((folder: TAbstractFile) => {
            if (folder instanceof TFolder && folder.path.toLowerCase().includes(lowerCaseInputStr)) {
                folders.push(folder);
            }
        });

        return folders;
    }

    renderSuggestion(file: TFolder, el: HTMLElement): void {
        el.setText(file.path);
    }

    selectSuggestion(file: TFolder): void {
        this.inputEl.value = file.path;
        this.inputEl.dispatchEvent(new Event('input'));
    }

    close(): void {
        // Implementieren Sie hier die Logik zum Schließen des Suggest-Fensters
    }
}

const DEFAULT_SETTINGS: SorteeerSettings = {
	sortFolder: '/',
	sortOrder: 'random',
	deleteAction: 'trash',
	moveAction: 'Archive',
	removeTagAction: '#stub',
	addTagAction: '#reviewed',
	addLinkAction: '',
	seeAlsoHeader: 'See also',
	dailyNoteFormat: 'YYYY-MM-DD',
	dailyNoteFolder: '/',
	dailyNoteSection: '## Reviewed',
	showNotifications: true,
	urlFetchFields: ['title', 'description', 'image'],
	groqApiKey: '',
	groqModel: 'llama-3.1-8b-instant',
	outputImages: true,
	fileRenamingPrompt: 'Generate a concise and descriptive filename for a file in an Obsidian vault. The filename should be 3 to 7 words long, human-readable, spaces are allowed, no need to use underscores, dashes or other escape sympols. Don\'t add any introduction or conclusion, just the short filename. If there are multiple distinct subjects or different links in the content, create title that helps overview all the subjects. Base filename on the following:\n\n${content.slice(0, 2000)}. Don\'t output underscores, "_".'
}

interface ActionStats {
	[key: string]: number;
}

export default class SorteeerPlugin extends Plugin {
	settings: SorteeerSettings;
	sorteeerModal: SorteeerModal;
	actionStats: ActionStats = {};
	deletedNotes: DeletedNote[] = [];

	openSettingsTab() {
		this.app.workspace.getLeaf().setViewState({
			type: 'plugin',
			state: { id: 'sorteeer' }
		});
	}

	async onload() {
		await this.loadSettings();
		await this.loadActionStats();

		this.addRibbonIcon('sort', 'Sorteeer', () => {
			this.openSorteeerModal();
		});

		this.addCommand({
			id: 'open-sorteeer',
			name: 'Open Sorteeer',
			callback: () => {
				this.openSorteeerModal();
			}
		});

		this.addCommand({
			id: 'undo-last-deletion',
			name: 'Undo Last Deletion',
			callback: () => {
				this.undoLastDeletion();
			}
		});

		this.registerDomEvent(document, 'keydown', (event: KeyboardEvent) => {
			if (event.altKey && event.key >= '1' && event.key <= '5') {
				this.handleGlobalShortcut(parseInt(event.key));
				event.preventDefault();
			}
			if ((event.metaKey || event.ctrlKey) && event.key === 'z') {
				this.undoLastDeletion();
				event.preventDefault();
			}
		});

		this.addSettingTab(new SorteeerSettingTab(this.app, this));

		// Add contextual menu for folders
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFolder) {
					menu.addItem((item) => {
						item
							.setTitle("Run Sorteeer on this folder")
							.setIcon("sort")
							.onClick(() => {
								this.settings.sortFolder = file.path;
								this.saveSettings();
								this.openSorteeerModal();
							});
					});
				}
			})
		);
	}

	public handleFolderChange() {
		if (this.sorteeerModal) {
			this.sorteeerModal.resetNotes();
			this.sorteeerModal.reloadWindow();
		}
	}

	async undoLastDeletion() {
		const lastDeleted = this.deletedNotes.pop();
		if (lastDeleted) {
			await this.app.vault.create(lastDeleted.file.path, lastDeleted.content);
			this.showNotification(`Restored: ${lastDeleted.file.name}`);
		} else {
			this.showNotification("No more deletions to undo");
		}
	}

	onunload() {
		if (this.sorteeerModal) {
			this.sorteeerModal.close();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		const oldSortFolder = this.settings.sortFolder;
		await this.saveData(this.settings);
		if (this.settings.sortFolder !== oldSortFolder) {
			this.handleFolderChange();
		}
	}

	async loadActionStats() {
		const stats = await this.loadData();
		this.actionStats = stats?.actionStats || {};
	}

	async saveActionStats() {
		await this.saveData({ ...await this.loadData(), actionStats: this.actionStats });
	}

	openSorteeerModal() {
		if (this.sorteeerModal) {
			this.sorteeerModal.close();
		}
		this.sorteeerModal = new SorteeerModal(this.app, this);
		this.sorteeerModal.open();
	}

	handleGlobalShortcut(num: number) {
		if (this.sorteeerModal && this.sorteeerModal.currentNote) {
			switch(num) {
				case 1:
					(this.sorteeerModal as any).removeTag();
					break;
				case 2:
					(this.sorteeerModal as any).addTag();
					break;
				case 3:
					(this.sorteeerModal as any).addStar();
					break;
				case 4:
					(this.sorteeerModal as any).addLink();
					break;
				case 5:
					(this.sorteeerModal as any).addToDailyNote();
					break;
			}
		}
	}

	incrementActionStat(action: string) {
		this.actionStats[action] = (this.actionStats[action] || 0) + 1;
		this.saveActionStats();
	}

	showNotification(message: string) {
		if (this.settings.showNotifications) {
			new Notice(message);
		}
	}

	async fetchUrlContent(url: string): Promise<{ [key: string]: string }> {
		try {
			return await fetchUrlContent(url, this.settings.urlFetchFields);
		} catch (error) {
			console.error('Error fetching URL content:', error);
			this.showNotification('Failed to fetch URL content. Please try again.');
			throw error;
		}
	}

	async addToDailyNote(currentNote: TFile | null) {
		if (currentNote) {
			const dailyNote = await this.getDailyNote();
			if (dailyNote) {
				let content = await this.app.vault.read(dailyNote);
				const linkToAdd = `[[${currentNote.basename}]]`;
				const sectionToAdd = this.settings.dailyNoteSection;
				
				if (content.includes(sectionToAdd)) {
					const parts = content.split(sectionToAdd);
					parts[1] = `\n- ${linkToAdd}${parts[1]}`;
					content = parts.join(sectionToAdd);
				} else {
					content += `\n\n${sectionToAdd}\n- ${linkToAdd}`;
				}

				await this.app.vault.modify(dailyNote, content);
				this.incrementActionStat('addToDailyNote');
				this.showNotification(`Added link to daily note: ${dailyNote.basename}`);
			} else {
				this.showNotification("Failed to find or create daily note");
			}
		}
	}

	async getDailyNote(): Promise<TFile | null> {
		const { moment } = window;
		const dateString = moment().format(this.settings.dailyNoteFormat);
		const dailyNotePath = `${this.settings.dailyNoteFolder}/${dateString}.md`;
		let dailyNote = this.app.vault.getAbstractFileByPath(dailyNotePath);

		if (!dailyNote) {
			try {
				dailyNote = await this.app.vault.create(dailyNotePath, "");
			} catch (err) {
				console.error("Failed to create daily note", err);
				// If the file already exists, try to get it again
				dailyNote = this.app.vault.getAbstractFileByPath(dailyNotePath);
			}
		}

		if (dailyNote instanceof TFile) {
			return dailyNote;
		} else {
			this.showNotification("Failed to find or create daily note");
			return null;
		}
	}
}

class SorteeerModal extends Modal {
	plugin: SorteeerPlugin;
	currentNote: TFile | null;
	private sortedNotes: TFile[] = [];
	private currentIndex: number = 0;

	constructor(app: App, plugin: SorteeerPlugin) {
		super(app);
		this.plugin = plugin;
	}


	onOpen() {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('sorteeer-modal');
		this.loadNextNote();
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.removeEventListener('keydown', this.onKeyDown);
	}

	private getNotesReviewedToday(): { reviewed: number; deleted: number } {
		const today = new Date().toDateString();
		let reviewed = 0;
		let deleted = 0;
		for (const [action, actionCount] of Object.entries(this.plugin.actionStats)) {
			if (action === 'noteDisplayed' || action.startsWith(today)) {
				reviewed += actionCount;
			}
			if (action === 'deleteNote') {
				deleted += actionCount;
			}
		}
		return { reviewed, deleted };
	}

	async loadNextNote() {
		const {contentEl} = this;
		contentEl.empty(); // Clear previous content

		const folder = this.app.vault.getAbstractFileByPath(this.plugin.settings.sortFolder) as TFolder;
		if (!folder) {
			this.displayEmptyFolderMessage('Invalid folder path');
			return;
		}

		const notes = folder.children.filter(file => file instanceof TFile && file.extension === 'md') as TFile[];
		
		if (notes.length === 0) {
			this.displayEmptyFolderMessage('No notes found in the specified folder');
			return;
		}

		if (this.sortedNotes.length === 0 || this.currentIndex >= this.sortedNotes.length) {
			switch (this.plugin.settings.sortOrder) {
				case 'random':
					this.sortedNotes = notes.sort(() => Math.random() - 0.5);
					break;
				case 'oldest':
					this.sortedNotes = notes.sort((a, b) => a.stat.ctime - b.stat.ctime);
					break;
				case 'newest':
					this.sortedNotes = notes.sort((a, b) => b.stat.ctime - a.stat.ctime);
					break;
				case 'smallest':
					this.sortedNotes = notes.sort((a, b) => a.stat.size - b.stat.size);
					break;
			}
			this.currentIndex = 0;
		}

		this.currentNote = this.sortedNotes[this.currentIndex];
		await this.displayNote(this.currentNote);
		this.currentIndex++;

		if (this.currentIndex >= this.sortedNotes.length) {
			this.currentIndex = 0;
		}
	}

	resetNotes() {
		this.sortedNotes = [];
		this.currentIndex = 0;
	}

	reloadWindow() {
		this.contentEl.empty();
		this.onOpen();
	}

	async displayNote(note: TFile) {
		const {contentEl} = this;
		contentEl.empty();

		// Increment the action stat for displaying a note
		this.plugin.incrementActionStat('noteDisplayed');

		const actionBar = contentEl.createDiv('action-bar');
		this.createActionButton(actionBar, 'Delete', 'Delete note', () => this.deleteNote(), 'Alt+Delete');
		const moveFolder = this.plugin.settings.moveAction === '/' ? 'Root' : this.plugin.settings.moveAction;
		this.createActionButton(actionBar, `Move to ${this.plugin.settings.moveAction}`, `Move note to ${this.plugin.settings.moveAction} folder`, () => this.moveNote(), 'Alt+↓');
		this.createActionButton(actionBar, 'Skip', 'Skip note', () => this.skipNote(), 'Alt+→');
		this.createActionButton(actionBar, 'More', 'Show more actions', () => this.showMoreActions(), 'Alt+↑').setAttribute('data-action', 'more');

		const titleContainer = contentEl.createDiv('sorteeer-title-container');

		const titleEl = titleContainer.createEl('h2', {text: note.basename, cls: 'sorteeer-note-title'});

		const editLink = titleContainer.createEl('a', {text: 'Edit', cls: 'sorteeer-edit-link'});
		editLink.addEventListener('click', (e) => {
			e.preventDefault();
			if (note) {
				this.app.workspace.openLinkText(note.path, '', true);
			} else {
				new Notice('Unable to open the file. Note not found.');
			}
		});
		titleEl.setAttribute('contenteditable', 'true');
		titleEl.addEventListener('dblclick', (e) => {
			e.preventDefault();
			titleEl.focus();
		});
		titleEl.addEventListener('blur', async () => {
			const newTitle = titleEl.innerText.trim();
			if (newTitle !== note.basename) {
				const newPath = note.path.replace(note.basename, newTitle);
				await this.app.fileManager.renameFile(note, newPath);
				this.currentNote = this.app.vault.getAbstractFileByPath(newPath) as TFile;
			}
		});

		const content = await this.app.vault.read(note);
		const noteContent = contentEl.createDiv('note-content');
		await MarkdownRenderer.renderMarkdown(content, noteContent, note.path, this.plugin);

		// Add "Fetch URL" button
		const fetchUrlButton = contentEl.createEl('button', {text: 'Fetch URL', cls: 'sorteeer-fetch-url'});
		fetchUrlButton.addEventListener('click', () => this.fetchAndAddUrlContent());

		// Add "Generate Filename" button
		const generateFilenameButton = contentEl.createEl('button', {text: 'Generate Filename', cls: 'sorteeer-generate-filename'});
		generateFilenameButton.addEventListener('click', () => this.generateFilenameWithGroq());

		// Add event listener for keyboard shortcuts
		contentEl.addEventListener('keydown', this.onKeyDown);

		this.createFooter();

		this.focusSkipButton();
	}

	async fetchAndAddUrlContent() {
		if (!this.currentNote) {
			this.plugin.showNotification('No current note selected');
			return;
		}

		const content = await this.app.vault.read(this.currentNote);
		const urls = extractUnlinkedUrls(content);
		if (urls.length === 0) {
			this.plugin.showNotification('No unlinked URLs found in the note');
			return;
		}

		this.plugin.showNotification('Fetching URL content...');
		let updatedContent = content;
		for (const url of urls) {
			try {
				const fetchedContent = await fetchUrlContent(
					url,
					this.plugin.settings.urlFetchFields
				);

				if (fetchedContent.title && fetchedContent.title !== "Site Unreachable") {
					let replacement = `[${fetchedContent.title}](${url})`;
					if (this.plugin.settings.outputImages && fetchedContent.image) {
						replacement += `\n![](${fetchedContent.image})`;
					}
					if (fetchedContent.description) {
						replacement += `\n${fetchedContent.description}`;
					}
					updatedContent = updatedContent.replace(url, replacement);
				}
			} catch (error) {
				console.error(`Error fetching content for ${url}:`, error);
				this.plugin.showNotification(`Failed to fetch content for ${url}`);
			}
		}

		await this.app.vault.modify(this.currentNote, updatedContent);
		this.plugin.showNotification('URL content added successfully');
		this.displayNote(this.currentNote);
	}

	displayEmptyFolderMessage(message: string) {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.createEl('h2', {text: 'Sorteeer'});
		contentEl.createEl('p', {text: message});
		
		const selectFolderButton = contentEl.createEl('button', {text: 'Select New Folder', cls: 'sorteeer-select-folder'});
		selectFolderButton.addEventListener('click', () => {
			new FolderSuggestModal(this.app, this.plugin, (folder: TFolder) => {
				this.plugin.settings.sortFolder = folder.path;
				this.plugin.saveSettings();
				this.loadNextNote();
			}).open();
		});
	}

	openSettingsTab() {
		this.app.workspace.getLeaf().setViewState({
			type: 'plugin',
			state: { id: 'sorteeer' }
		});
	}

	createActionButton(container: HTMLElement, text: string, tooltip: string, callback: () => void, shortcut?: string): HTMLButtonElement {
		const button = container.createEl('button');
		const textEl = button.createSpan({text: text});
		button.title = tooltip;
		button.addEventListener('click', callback);
		if (shortcut) {
			const shortcutEl = button.createSpan({text: shortcut, cls: 'sorteeer-shortcut'});
		}
		return button;
	}

	async deleteNote() {
		if (this.currentNote) {
			if (await this.app.vault.adapter.exists(this.currentNote.path)) {
				const content = await this.app.vault.read(this.currentNote);
				this.plugin.deletedNotes.push({ file: this.currentNote, content: content });
				await this.app.vault.trash(this.currentNote, true);
				this.plugin.showNotification(`Deleted: ${this.currentNote.name} (Cmd+Z to undo)`);
				this.loadNextNote();
			} else {
				this.plugin.showNotification("File has already been removed");
				this.loadNextNote();
			}
		}
	}

	async moveNote() {
		if (this.currentNote) {
			const targetFolder = this.app.vault.getAbstractFileByPath(this.plugin.settings.moveAction) as TFolder;
			if (targetFolder) {
				await this.app.fileManager.renameFile(this.currentNote, `${targetFolder.path}/${this.currentNote.name}`);
				this.plugin.incrementActionStat('moveToFolder');
				this.plugin.showNotification(`Moved to ${this.plugin.settings.moveAction}: ${this.currentNote.name}`);
				this.loadNextNote();
			} else {
				this.plugin.showNotification(`${this.plugin.settings.moveAction} folder not found. Please create it first.`);
			}
		}
	}

	skipNote() {
		this.loadNextNote();
	}

	navigateToPreviousNote() {
		if (this.currentIndex > 0) {
			this.currentIndex -= 2;
			this.loadNextNote();
		} else {
			// If we're at the start, wrap around to the end
			this.currentIndex = this.sortedNotes.length - 1;
			this.loadNextNote();
		}
	}

	copyNoteLink(note: TFile) {
		const noteLink = this.app.fileManager.generateMarkdownLink(note, '');
		navigator.clipboard.writeText(noteLink);
		new Notice('Note link copied to clipboard');
		this.loadNextNote();
	}

	showMoreActions() {
		const modal = new MoreActionsModal(this.app, this.plugin, this);
		modal.open();
	}

	onKeyDown = (event: KeyboardEvent) => {
		if (event.altKey) {
			switch(event.key) {
				case 'Delete':
					this.deleteNote();
					break;
				case 'ArrowDown':
					this.moveNote();
					break;
				case 'ArrowRight':
					this.skipNote();
					break;
				case 'ArrowUp':
					this.showMoreActions();
					break;
				case 'ArrowLeft':
					this.navigateToPreviousNote();
					break;
			}
			event.preventDefault();
		}
	}

	focusSkipButton() {
		const skipButton = this.contentEl.querySelector('button:nth-child(3)') as HTMLButtonElement;
		if (skipButton) {
			skipButton.focus();
		}
	}

	createFooter() {
		const footer = this.contentEl.createEl('div', {cls: 'sorteeer-footer'});
		const { reviewed, deleted } = this.getNotesReviewedToday();
		const folderInfo = footer.createEl('div', {cls: 'sorteeer-folder-info'});
		folderInfo.createSpan({text: `Current folder: ${this.plugin.settings.sortFolder} `});
		const changeLink = folderInfo.createEl('a', {text: 'Change', cls: 'sorteeer-change-folder'});
		changeLink.addEventListener('click', (e) => {
			e.preventDefault();
			new FolderSuggestModal(this.app, this.plugin, (folder: TFolder) => {
				this.plugin.settings.sortFolder = folder.path;
				this.plugin.saveSettings();
				this.loadNextNote();
				this.createFooter(); // Refresh the footer
			}).open();
		});
		footer.createEl('div', {text: `Notes reviewed today: ${reviewed} | Deleted: ${deleted}`});
	}

	async generateFilenameWithGroq() {
		if (this.currentNote) {
			const content = await this.app.vault.read(this.currentNote);
			try {
				const newFilename = await generateFilenameWithGroq(content, this.plugin.settings.groqApiKey, this.plugin.settings.groqModel, this.plugin.settings.fileRenamingPrompt);
				console.log('Raw generated filename:', newFilename); // Add this line
				const newPath = this.currentNote.path.replace(this.currentNote.basename, newFilename);
				await this.app.fileManager.renameFile(this.currentNote, newPath);
				this.currentNote = this.app.vault.getAbstractFileByPath(newPath) as TFile;
				this.plugin.showNotification(`File renamed to: ${newFilename}`);
				this.displayNote(this.currentNote);
			} catch (error) {
				this.plugin.showNotification('Failed to generate filename with Groq');
				console.error(error);
			}
		}
	}
}

class MoreActionsModal extends Modal {
	plugin: SorteeerPlugin;
	parentModal: SorteeerModal;
	actions: {text: string, callback: () => void}[];
	selectedIndex: number;

	constructor(app: App, plugin: SorteeerPlugin, parentModal: SorteeerModal) {
		super(app);
		this.plugin = plugin;
		this.parentModal = parentModal;
		this.actions = [
			{text: `Remove Tag (${this.plugin.settings.removeTagAction})`, callback: () => this.removeTag()},
			{text: `Add Tag (${this.plugin.settings.addTagAction})`, callback: () => this.addTag()},
			// Bookmarking action removed
			{text: 'Add Link', callback: () => this.addLink()},
			{text: 'Add to Daily Note', callback: () => this.addToDailyNote()},
			{text: 'Copy Link', callback: () => this.copyNoteLink()}
		];
		this.selectedIndex = 0;
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('sorteeer-more-actions');

		this.actions.forEach((action, index) => {
			const button = this.createActionButton(action.text, () => this.executeAction(index), index + 1);
		});

		this.updateSelectedButton();

		contentEl.addEventListener('keydown', this.handleKeyDown);
	}

	onClose() {
		const {contentEl} = this;
		contentEl.removeEventListener('keydown', this.handleKeyDown);
	}

	createActionButton(text: string, callback: () => void, number: number): HTMLButtonElement {
		const button = this.contentEl.createEl('button');
		const textEl = button.createSpan({text: text});
		const shortcutEl = button.createSpan({text: `${number}`, cls: 'sorteeer-shortcut'});
		button.addEventListener('click', () => {
			callback();
			this.close();
		});
		return button;
	}

	updateSelectedButton() {
		const buttons = this.contentEl.querySelectorAll('button');
		buttons.forEach((button, index) => {
			if (index === this.selectedIndex) {
				button.addClass('selected');
			} else {
				button.removeClass('selected');
			}
		});
	}

	executeAction(index: number) {
		this.actions[index].callback();
		this.close();
	}

	handleKeyDown = (event: KeyboardEvent) => {
		const num = parseInt(event.key);
		if (num >= 1 && num <= this.actions.length) {
			this.executeAction(num - 1);
			event.preventDefault();
			this.close();
		} else if (event.key === 'ArrowUp') {
			this.selectedIndex = (this.selectedIndex - 1 + this.actions.length) % this.actions.length;
			this.updateSelectedButton();
			event.preventDefault();
		} else if (event.key === 'ArrowDown') {
			this.selectedIndex = (this.selectedIndex + 1) % this.actions.length;
			this.updateSelectedButton();
			event.preventDefault();
		} else if (event.key === 'Enter') {
			this.executeAction(this.selectedIndex);
			event.preventDefault();
			this.close();
		}
	}

	async removeTag() {
		if (this.parentModal.currentNote) {
			let content = await this.app.vault.read(this.parentModal.currentNote);
			content = content.replace(new RegExp(this.plugin.settings.removeTagAction, 'g'), '');
			await this.app.vault.modify(this.parentModal.currentNote, content);
			this.parentModal.displayNote(this.parentModal.currentNote);
			this.plugin.incrementActionStat('removeTag');
			this.plugin.showNotification('Tag removed');
		}
	}

	async addTag() {
		if (this.parentModal.currentNote) {
			let content = await this.app.vault.read(this.parentModal.currentNote);
			content += `\n${this.plugin.settings.addTagAction}`;
			await this.app.vault.modify(this.parentModal.currentNote, content);
			this.parentModal.displayNote(this.parentModal.currentNote);
			this.plugin.incrementActionStat('addTag');
			this.plugin.showNotification('Tag added');
		}
	}

	// Bookmarking functionality has been disabled

	async addLink() {
		if (this.parentModal.currentNote) {
			new AddLinkModal(this.app, this.plugin, this.parentModal).open();
		}
	}

	copyNoteLink() {
		if (this.parentModal.currentNote) {
			const noteLink = this.app.fileManager.generateMarkdownLink(this.parentModal.currentNote, '');
			navigator.clipboard.writeText(noteLink);
			this.plugin.showNotification('Note link copied to clipboard');
			this.close();
			this.parentModal.loadNextNote();
		}
	}

	async addToDailyNote() {
		if (this.parentModal.currentNote) {
			console.log("Adding note to daily note");
			const dailyNote = await this.getDailyNote();
			if (dailyNote) {
				try {
					let content = await this.app.vault.read(dailyNote);
					const linkToAdd = `[[${this.parentModal.currentNote.basename}]]`;
					const sectionToAdd = this.plugin.settings.dailyNoteSection;
					
					console.log(`Current daily note content length: ${content.length}`);
					console.log(`Adding link: ${linkToAdd}`);
					
					if (content.includes(sectionToAdd)) {
						console.log("Section already exists, appending link");
						const parts = content.split(sectionToAdd);
						parts[1] = `\n- ${linkToAdd}${parts[1]}`;
						content = parts.join(sectionToAdd);
					} else {
						console.log("Section doesn't exist, creating new section");
						content += `\n\n${sectionToAdd}\n- ${linkToAdd}`;
					}

					await this.app.vault.modify(dailyNote, content);
					console.log("Successfully modified daily note");
					this.plugin.incrementActionStat('addToDailyNote');
					this.plugin.showNotification(`Added link to daily note: ${dailyNote.basename}`);
					this.close();
					this.parentModal.loadNextNote();
				} catch (err) {
					console.error("Error while modifying daily note:", err);
					this.plugin.showNotification("Failed to modify daily note");
				}
			} else {
				console.error("Failed to find or create daily note");
				this.plugin.showNotification("Failed to find or create daily note");
			}
		} else {
			console.error("No current note selected");
			this.plugin.showNotification("No note selected to add to daily note");
		}
	}

	async getDailyNote(): Promise<TFile | null> {
		const { moment } = window;
		const dateString = moment().format(this.plugin.settings.dailyNoteFormat);
		const dailyNotePath = `${this.plugin.settings.dailyNoteFolder}/${dateString}.md`;
		let dailyNote = this.app.vault.getAbstractFileByPath(dailyNotePath);

		console.log(`Attempting to get or create daily note: ${dailyNotePath}`);

		if (!dailyNote) {
			console.log("Daily note doesn't exist, creating new file");
			try {
				dailyNote = await this.app.vault.create(dailyNotePath, "");
				console.log("Daily note created successfully");
			} catch (err) {
				console.error("Error while creating daily note:", err);
				if (err.message.includes("already exists")) {
					console.log("File already exists, attempting to retrieve it");
					dailyNote = this.app.vault.getAbstractFileByPath(dailyNotePath);
				}
			}
		} else {
			console.log("Daily note already exists");
		}

		if (dailyNote instanceof TFile) {
			console.log("Successfully retrieved daily note");
			return dailyNote;
		} else {
			console.error("Failed to find or create daily note");
			this.plugin.showNotification("Failed to find or create daily note");
			return null;
		}
	}
}

class AddLinkModal extends SuggestModal<TFile> {
	plugin: SorteeerPlugin;
	parentModal: SorteeerModal;

	constructor(app: App, plugin: SorteeerPlugin, parentModal: SorteeerModal) {
		super(app);
		this.plugin = plugin;
		this.parentModal = parentModal;
	}

	getSuggestions(query: string): TFile[] {
		return this.app.vault.getMarkdownFiles()
			.filter(file => file.path.toLowerCase().includes(query.toLowerCase()));
	}

	renderSuggestion(file: TFile, el: HTMLElement) {
		el.createEl("div", { text: file.path });
	}

	onChooseSuggestion(file: TFile, evt: MouseEvent | KeyboardEvent) {
		this.addLink(file.basename);
	}

	async addLink(linkText: string) {
		if (linkText && this.parentModal.currentNote) {
			let content = await this.app.vault.read(this.parentModal.currentNote);
			const seeAlsoHeader = this.plugin.settings.seeAlsoHeader;
			const newLink = `- [[${linkText}]]`;

			if (content.includes(seeAlsoHeader)) {
				const headerIndex = content.indexOf(seeAlsoHeader);
				const headerEndIndex = headerIndex + seeAlsoHeader.length;
				const beforeHeader = content.slice(0, headerEndIndex);
				const afterHeader = content.slice(headerEndIndex);
				content = beforeHeader + '\n' + newLink + afterHeader;
			} else {
				content += `\n\n${seeAlsoHeader}\n${newLink}`;
			}

			await this.app.vault.modify(this.parentModal.currentNote, content);
			this.parentModal.displayNote(this.parentModal.currentNote);
			this.close();
		}
	}
}

async function generateFilenameWithGroq(content: string, apiKey: string, model: string, prompt: string): Promise<string> {
	const endpoint = 'https://api.groq.com/openai/v1/chat/completions';
	const headers = {
		'Authorization': `Bearer ${apiKey}`,
		'Content-Type': 'application/json'
	};
	const formattedPrompt = prompt.replace('${content.slice(0, 2000)}', content.slice(0, 2000));
    
    console.log('Full prompt being sent to LLM:', formattedPrompt); // Log the full prompt

	const body = JSON.stringify({
		model: model,
		messages: [
			{role: "system", content: "You are a helpful assistant."},
			{role: "user", content: formattedPrompt}
		],
		max_tokens: 50,
		temperature: 0.3
	});

	try {
		const response = await fetch(endpoint, {method: 'POST', headers: headers, body: body});
		const data = await response.json();
		if (data.choices && data.choices.length > 0) {
			return data.choices[0].message.content.trim().replace(/[^a-zA-Z0-9-_ ]/g, ' ').replace(/_/g, ' ');
		} else {
			throw new Error('No filename generated');
		}
	} catch (error) {
		console.error('Error generating filename with Groq:', error);
		throw error;
	}
}

class SorteeerSettingTab extends PluginSettingTab {
	plugin: SorteeerPlugin;

	constructor(app: App, plugin: SorteeerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		const refreshDisplay = () => {
			containerEl.empty();
			this.display();
		};

		new Setting(containerEl)
			.setName('Sort Folder')
			.setDesc('Folder to sort through')
			.addSearch(cb => {
				new FolderSuggest(this.app, cb.inputEl);
				cb.setPlaceholder('Enter folder path')
					.setValue(this.plugin.settings.sortFolder)
					.onChange(async (value) => {
						this.plugin.settings.sortFolder = value;
						await this.plugin.saveSettings();
						this.plugin.handleFolderChange();
						cb.setValue(value);  // Update the input field value
					});
			});

		containerEl.createEl('div', {text: `Current sort folder: ${this.plugin.settings.sortFolder}`, cls: 'setting-item-description'});

		new Setting(containerEl)
			.setName('Sort Order')
			.setDesc('How to order the notes')
			.addDropdown(dropdown => dropdown
				.addOption('random', 'Random')
				.addOption('oldest', 'Oldest First')
				.addOption('newest', 'Newest First')
				.addOption('smallest', 'Smallest First')
				.setValue(this.plugin.settings.sortOrder)
				.onChange(async (value: 'random' | 'oldest' | 'newest' | 'smallest') => {
					this.plugin.settings.sortOrder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Delete Action')
			.setDesc('Action for left swipe or left arrow')
			.addText(text => text
				.setPlaceholder('Enter delete action')
				.setValue(this.plugin.settings.deleteAction)
				.onChange(async (value) => {
					this.plugin.settings.deleteAction = value;
					await this.plugin.saveSettings();
				}));

		let moveActionText: TextComponent;
		new Setting(containerEl)
			.setName('Move Action')
			.setDesc('Folder to move notes to on down swipe or down arrow')
			.addText(text => {
				text
					.setPlaceholder('Enter folder path')
					.setValue(this.plugin.settings.moveAction)
					.onChange(async (value) => {
						this.plugin.settings.moveAction = value;
						await this.plugin.saveSettings();
					});
				moveActionText = text;
			})
			.addButton(button => button
				.setButtonText('Select Folder')
				.onClick(async () => {
					new FolderSuggestModal(this.app, this.plugin, async (folder: TFolder) => {
						this.plugin.settings.moveAction = folder.path;
						await this.plugin.saveSettings();
						moveActionText.setValue(folder.path);
						new Notice(`Move action folder set to: ${folder.path}`);
					}).open();
				}));

		new Setting(containerEl)
			.setName('Remove Tag Action')
			.setDesc('Tag to remove')
			.addText(text => text
				.setPlaceholder('Enter tag to remove')
				.setValue(this.plugin.settings.removeTagAction)
				.onChange(async (value) => {
					this.plugin.settings.removeTagAction = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Add Tag Action')
			.setDesc('Tag to add')
			.addText(text => text
				.setPlaceholder('Enter tag to add')
				.setValue(this.plugin.settings.addTagAction)
				.onChange(async (value) => {
					this.plugin.settings.addTagAction = value;
					await this.plugin.saveSettings();
				}));

		// Bookmark Action setting removed

		new Setting(containerEl)
			.setName('See Also Header')
			.setDesc('Header for the link section')
			.addText(text => text
				.setPlaceholder('Enter header text')
				.setValue(this.plugin.settings.seeAlsoHeader)
				.onChange(async (value) => {
					this.plugin.settings.seeAlsoHeader = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Daily Note Format')
			.setDesc('Format for daily note filenames (e.g., YYYY-MM-DD)')
			.addText(text => text
				.setPlaceholder('YYYY-MM-DD')
				.setValue(this.plugin.settings.dailyNoteFormat)
				.onChange(async (value) => {
					this.plugin.settings.dailyNoteFormat = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Daily Note Folder')
			.setDesc('Folder for daily notes')
			.addText(text => text
				.setPlaceholder('/')
				.setValue(this.plugin.settings.dailyNoteFolder)
				.onChange(async (value) => {
					this.plugin.settings.dailyNoteFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Daily Note Section')
			.setDesc('Section to add notes under in daily note')
			.addText(text => text
				.setPlaceholder('## Reviewed')
				.setValue(this.plugin.settings.dailyNoteSection)
				.onChange(async (value) => {
					this.plugin.settings.dailyNoteSection = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show Notifications')
			.setDesc('Show notifications for actions')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showNotifications)
				.onChange(async (value) => {
					this.plugin.settings.showNotifications = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('URL Fetch Fields')
			.setDesc('Fields to fetch when fetching URL content (comma-separated)')
			.addText(text => text
				.setPlaceholder('title,description,image')
				.setValue(this.plugin.settings.urlFetchFields.join(','))
				.onChange(async (value) => {
					this.plugin.settings.urlFetchFields = value.split(',').map(field => field.trim());
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('GROQ API Key')
			.setDesc('API key for GROQ')
			.addText(text => text
				.setPlaceholder('Enter your GROQ API key')
				.setValue(this.plugin.settings.groqApiKey)
				.onChange(async (value) => {
					this.plugin.settings.groqApiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('GROQ Model')
			.setDesc('Model to use for GROQ API calls')
			.addDropdown(dropdown => dropdown
				.addOption('llama-3.1-8b-instant', 'LLaMA 3.1 8B Instant')
				.addOption('llama-3.1-70b-instant', 'LLaMA 3.1 70B Instant')
				.addOption('mixtral-8x7b-instant', 'Mixtral 8x7B Instant')
				.setValue(this.plugin.settings.groqModel)
				.onChange(async (value) => {
					this.plugin.settings.groqModel = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('File Renaming Prompt')
			.setDesc('Prompt to use for generating new filenames')
			.addTextArea(text => text
				.setPlaceholder('Enter the prompt for file renaming')
				.setValue(this.plugin.settings.fileRenamingPrompt)
				.onChange(async (value) => {
					this.plugin.settings.fileRenamingPrompt = value;
					await this.plugin.saveSettings();
				}))
			.setClass('sorteeer-file-renaming-prompt');


		// Add a button to view action stats
		new Setting(containerEl)
			.setName('View Action Stats')
			.setDesc('View statistics for performed actions')
			.addButton(button => button
				.setButtonText('View Stats')
				.onClick(() => {
					new StatsModal(this.app, this.plugin).open();
				}));
	}
}
class StatsModal extends Modal {
	plugin: SorteeerPlugin;

	constructor(app: App, plugin: SorteeerPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('sorteeer-stats-modal');

		contentEl.createEl('h2', {text: 'Action Statistics'});

		const statsContainer = contentEl.createEl('div', {cls: 'sorteeer-stats-container'});

		const actionLabels: {[key: string]: string} = {
			'noteDisplayed': 'Notes Reviewed',
			'deleteNote': 'Notes Deleted',
			'moveToFolder': 'Notes Moved',
			'removeTag': 'Tags Removed',
			'addTag': 'Tags Added',
			// 'toggleBookmark' stat removed
			'addLink': 'Links Added',
			'addToDailyNote': 'Added to Daily Notes'
		};

		const todayStats: {[key: string]: number} = {};
		const allTimeStats: {[key: string]: number} = {};

		const today = new Date().toDateString();

		for (const [action, count] of Object.entries(this.plugin.actionStats)) {
			if (action.startsWith(today)) {
				const actionType = action.split(' ')[1];
				todayStats[actionType] = (todayStats[actionType] || 0) + count;
			} else {
				allTimeStats[action] = count;
			}
		}

		this.createStatsSection(statsContainer, 'Today\'s Activity', todayStats, actionLabels);
		this.createStatsSection(statsContainer, 'All-Time Activity', allTimeStats, actionLabels);

		const closeButton = contentEl.createEl('button', {text: 'Close', cls: 'sorteeer-close-button'});
		closeButton.addEventListener('click', () => this.close());
	}

	createStatsSection(container: HTMLElement, title: string, stats: {[key: string]: number}, labels: {[key: string]: string}) {
		const sectionEl = container.createEl('div', {cls: 'sorteeer-stats-section'});
		sectionEl.createEl('h3', {text: title});

		for (const [action, count] of Object.entries(stats)) {
			const statEl = sectionEl.createEl('div', {cls: 'sorteeer-stat-item'});
			const label = labels[action] || this.humanizeAction(action);
			statEl.createEl('span', {text: `${label}: `, cls: 'sorteeer-stat-label'});
			statEl.createEl('span', {text: `${count}`, cls: 'sorteeer-stat-value'});
		}
	}

	humanizeAction(action: string): string {
		return action
			.replace(/([A-Z])/g, ' $1')
			.replace(/^./, str => str.toUpperCase());
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}
class FolderSuggestModal extends SuggestModal<TFolder> {
	plugin: SorteeerPlugin;
	onChoose: (folder: TFolder) => void;

	constructor(app: App, plugin: SorteeerPlugin, onChoose: (folder: TFolder) => void) {
		super(app);
		this.plugin = plugin;
		this.onChoose = onChoose;
	}

	getSuggestions(query: string): TFolder[] {
		return this.app.vault.getAllLoadedFiles()
			.filter(file => file instanceof TFolder && file.path.toLowerCase().includes(query.toLowerCase())) as TFolder[];
	}

	renderSuggestion(folder: TFolder, el: HTMLElement) {
		el.createEl("div", { text: folder.path });
	}

	onChooseSuggestion(folder: TFolder, evt: MouseEvent | KeyboardEvent) {
		this.plugin.settings.sortFolder = folder.path;
		this.plugin.saveSettings();
		this.onChoose(folder);
		if (this.plugin.sorteeerModal) {
			this.plugin.sorteeerModal.loadNextNote();
		}
		this.close();
	}
}
