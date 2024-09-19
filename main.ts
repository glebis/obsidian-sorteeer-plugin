import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, MarkdownRenderer, SuggestModal } from 'obsidian';

interface SorteeerSettings {
	sortFolder: string;
	sortOrder: 'random' | 'oldest' | 'newest' | 'smallest';
	deleteAction: string;
	moveAction: string;
	removeTagAction: string;
	addTagAction: string;
	addStarAction: string;
	addLinkAction: string;
	seeAlsoHeader: string;
	dailyNoteFormat: string;
	dailyNoteFolder: string;
	dailyNoteSection: string;
}

const DEFAULT_SETTINGS: SorteeerSettings = {
	sortFolder: '/',
	sortOrder: 'random',
	deleteAction: 'trash',
	moveAction: 'Archive',
	removeTagAction: '#stub',
	addTagAction: '#reviewed',
	addStarAction: '⭐',
	addLinkAction: '',
	seeAlsoHeader: 'See also',
	dailyNoteFormat: 'YYYY-MM-DD',
	dailyNoteFolder: '/',
	dailyNoteSection: '## Reviewed'
}

export default class SorteeerPlugin extends Plugin {
	settings: SorteeerSettings;
	sorteeerModal: SorteeerModal;

	async onload() {
		await this.loadSettings();

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

		this.addSettingTab(new SorteeerSettingTab(this.app, this));
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
		await this.saveData(this.settings);
	}

	openSorteeerModal() {
		if (this.sorteeerModal) {
			this.sorteeerModal.close();
		}
		this.sorteeerModal = new SorteeerModal(this.app, this);
		this.sorteeerModal.open();
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

	async loadNextNote() {
		const folder = this.app.vault.getAbstractFileByPath(this.plugin.settings.sortFolder) as TFolder;
		if (!folder) {
			new Notice('Sorteeer: Invalid folder path');
			return;
		}

		const notes = folder.children.filter(file => file instanceof TFile && file.extension === 'md') as TFile[];
		
		if (notes.length === 0) {
			new Notice('Sorteeer: No notes found in the specified folder');
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
		this.displayNote(this.currentNote);
		this.currentIndex++;

		if (this.currentIndex >= this.sortedNotes.length) {
			this.currentIndex = 0;
		}
	}

	async displayNote(note: TFile) {
		const {contentEl} = this;
		contentEl.empty();

		const editLink = contentEl.createEl('a', {text: 'Edit', cls: 'sorteeer-edit-link'});
		editLink.addEventListener('click', (e) => {
			e.preventDefault();
			const activeLeaf = this.app.workspace.activeLeaf;
			if (activeLeaf) {
				activeLeaf.openFile(note);
				this.close();
			} else {
				new Notice('Unable to open the file. No active leaf found.');
			}
		});

		const titleEl = contentEl.createEl('h2', {text: note.basename, cls: 'sorteeer-note-title'});
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

		const actionBar = contentEl.createDiv('action-bar');
		this.createActionButton(actionBar, 'Delete', this.plugin.settings.deleteAction, () => this.deleteNote(), '←');
		const moveFolder = this.plugin.settings.moveAction === '/' ? 'Root' : this.plugin.settings.moveAction;
		this.createActionButton(actionBar, `Move to ${moveFolder}`, `Move to ${moveFolder}`, () => this.moveNote(), '↓');
		this.createActionButton(actionBar, 'Skip', 'Skip to next note', () => this.skipNote(), '→');
		this.createActionButton(actionBar, 'More', 'More Actions', () => this.showMoreActions(), '↑');

		// Add event listener for keyboard shortcuts
		contentEl.addEventListener('keydown', this.onKeyDown);
	}

	createActionButton(container: HTMLElement, text: string, tooltip: string, callback: () => void, shortcut?: string) {
		const button = container.createEl('button', {text: text});
		button.title = tooltip;
		button.addEventListener('click', callback);
		if (shortcut) {
			const shortcutEl = button.createSpan({cls: 'sorteeer-shortcut'});
			shortcutEl.setText(`Alt+${shortcut}`);
		}
	}

	async deleteNote() {
		if (this.currentNote) {
			await this.app.vault.trash(this.currentNote, true);
			this.loadNextNote();
		}
	}

	async moveNote() {
		if (this.currentNote) {
			const targetFolder = this.app.vault.getAbstractFileByPath(this.plugin.settings.moveAction) as TFolder;
			if (targetFolder) {
				await this.app.fileManager.renameFile(this.currentNote, `${targetFolder.path}/${this.currentNote.name}`);
				this.loadNextNote();
			} else {
				new FolderSuggestModal(this.app, this.plugin, this).open();
			}
		}
	}

	skipNote() {
		this.loadNextNote();
	}

	showMoreActions() {
		const modal = new MoreActionsModal(this.app, this.plugin, this);
		modal.open();
	}

	onKeyDown = (event: KeyboardEvent) => {
		if (event.altKey) {
			switch(event.key) {
				case 'ArrowLeft':
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
				case '1':
				case '2':
				case '3':
				case '4':
					this.handleNumberShortcut(parseInt(event.key));
					break;
			}
			event.preventDefault();
		}
	}

	handleNumberShortcut(num: number) {
		switch(num) {
			case 1:
				this.deleteNote();
				break;
			case 2:
				this.moveNote();
				break;
			case 3:
				this.skipNote();
				break;
			case 4:
				this.showMoreActions();
				break;
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
			{text: `Add Star (${this.plugin.settings.addStarAction})`, callback: () => this.addStar()},
			{text: 'Add Link', callback: () => this.addLink()},
			{text: 'Add to Daily Note', callback: () => this.addToDailyNote()}
		];
		this.selectedIndex = 0;
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('sorteeer-more-actions');

		this.actions.forEach((action, index) => {
			this.createActionButton(action.text, () => this.executeAction(index), index + 1);
		});

		this.updateSelectedButton();

		contentEl.addEventListener('keydown', this.handleKeyDown);
	}

	onClose() {
		const {contentEl} = this;
		contentEl.removeEventListener('keydown', this.handleKeyDown);
	}

	createActionButton(text: string, callback: () => void, altNumber: number) {
		const button = this.contentEl.createEl('button');
		const textEl = button.createSpan({text: text});
		const shortcutEl = button.createSpan({cls: 'sorteeer-shortcut'});
		shortcutEl.setText(`Alt+${altNumber}`);
		button.addEventListener('click', () => {
			callback();
			this.close();
		});
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
		if (event.altKey) {
			const num = parseInt(event.key);
			if (num >= 1 && num <= this.actions.length) {
				this.executeAction(num - 1);
				event.preventDefault();
			}
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
		}
	}

	async removeTag() {
		if (this.parentModal.currentNote) {
			let content = await this.app.vault.read(this.parentModal.currentNote);
			content = content.replace(new RegExp(this.plugin.settings.removeTagAction, 'g'), '');
			await this.app.vault.modify(this.parentModal.currentNote, content);
			this.parentModal.displayNote(this.parentModal.currentNote);
		}
	}

	async addTag() {
		if (this.parentModal.currentNote) {
			let content = await this.app.vault.read(this.parentModal.currentNote);
			content += `\n${this.plugin.settings.addTagAction}`;
			await this.app.vault.modify(this.parentModal.currentNote, content);
			this.parentModal.displayNote(this.parentModal.currentNote);
		}
	}

	async addStar() {
		if (this.parentModal.currentNote) {
			let content = await this.app.vault.read(this.parentModal.currentNote);
			content = `${this.plugin.settings.addStarAction} ${content}`;
			await this.app.vault.modify(this.parentModal.currentNote, content);
			this.parentModal.displayNote(this.parentModal.currentNote);
		}
	}

	async addLink() {
		if (this.parentModal.currentNote) {
			new AddLinkModal(this.app, this.plugin, this.parentModal).open();
		}
	}

	async addToDailyNote() {
		if (this.parentModal.currentNote) {
			const dailyNote = await this.getDailyNote();
			if (dailyNote) {
				let content = await this.app.vault.read(dailyNote);
				const linkToAdd = `[[${this.parentModal.currentNote.basename}]]`;
				const sectionToAdd = this.plugin.settings.dailyNoteSection;
				
				if (content.includes(sectionToAdd)) {
					const parts = content.split(sectionToAdd);
					parts[1] = `\n- ${linkToAdd}${parts[1]}`;
					content = parts.join(sectionToAdd);
				} else {
					content += `\n\n${sectionToAdd}\n- ${linkToAdd}`;
				}

				await this.app.vault.modify(dailyNote, content);
				new Notice(`Added link to daily note: ${dailyNote.basename}`);
			} else {
				new Notice("Failed to find or create daily note");
			}
		}
	}

	async getDailyNote(): Promise<TFile | null> {
		const { moment } = window;
		const dateString = moment().format(this.plugin.settings.dailyNoteFormat);
		const dailyNotePath = `${this.plugin.settings.dailyNoteFolder}/${dateString}.md`;
		let dailyNote = this.app.vault.getAbstractFileByPath(dailyNotePath);

		if (!dailyNote) {
			try {
				dailyNote = await this.app.vault.create(dailyNotePath, "");
			} catch (err) {
				console.error("Failed to create daily note", err);
				return null;
			}
		}

		return dailyNote instanceof TFile ? dailyNote : null;
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
			const linkSection = `\n\n${this.plugin.settings.seeAlsoHeader}\n- [[${linkText}]]`;
			content += linkSection;
			await this.app.vault.modify(this.parentModal.currentNote, content);
			this.parentModal.displayNote(this.parentModal.currentNote);
			this.close();
		}
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

		new Setting(containerEl)
			.setName('Sort Folder')
			.setDesc('Folder to sort through')
			.addText(text => text
				.setPlaceholder('Enter folder path')
				.setValue(this.plugin.settings.sortFolder)
				.onChange(async (value) => {
					this.plugin.settings.sortFolder = value;
					await this.plugin.saveSettings();
				}));

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

		new Setting(containerEl)
			.setName('Move Action')
			.setDesc('Folder to move notes to on down swipe or down arrow')
			.addText(text => text
				.setPlaceholder('Enter folder path')
				.setValue(this.plugin.settings.moveAction)
				.onChange(async (value) => {
					this.plugin.settings.moveAction = value;
					await this.plugin.saveSettings();
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

		new Setting(containerEl)
			.setName('Add Star Action')
			.setDesc('Star symbol to add')
			.addText(text => text
				.setPlaceholder('Enter star symbol')
				.setValue(this.plugin.settings.addStarAction)
				.onChange(async (value) => {
					this.plugin.settings.addStarAction = value;
					await this.plugin.saveSettings();
				}));

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
	}
}
class FolderSuggestModal extends SuggestModal<TFolder> {
	plugin: SorteeerPlugin;
	parentModal: SorteeerModal;

	constructor(app: App, plugin: SorteeerPlugin, parentModal: SorteeerModal) {
		super(app);
		this.plugin = plugin;
		this.parentModal = parentModal;
	}

	getSuggestions(query: string): TFolder[] {
		return this.app.vault.getAllLoadedFiles()
			.filter(file => file instanceof TFolder && file.path.toLowerCase().includes(query.toLowerCase())) as TFolder[];
	}

	renderSuggestion(folder: TFolder, el: HTMLElement) {
		el.createEl("div", { text: folder.path });
	}

	onChooseSuggestion(folder: TFolder, evt: MouseEvent | KeyboardEvent) {
		this.plugin.settings.moveAction = folder.path;
		this.plugin.saveSettings();
		this.parentModal.moveNote();
	}
}
