import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, MarkdownRenderer, SuggestModal } from 'obsidian';

interface SorteeerSettings {
	sortFolder: string;
	sortOrder: 'random' | 'oldest' | 'newest';
	deleteAction: string;
	moveAction: string;
	removeTagAction: string;
	addTagAction: string;
	addStarAction: string;
	addLinkAction: string;
	seeAlsoHeader: string;
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
	seeAlsoHeader: 'See also'
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

		let note: TFile;
		switch (this.plugin.settings.sortOrder) {
			case 'random':
				note = notes[Math.floor(Math.random() * notes.length)];
				break;
			case 'oldest':
				note = notes.sort((a, b) => a.stat.ctime - b.stat.ctime)[0];
				break;
			case 'newest':
				note = notes.sort((a, b) => b.stat.ctime - a.stat.ctime)[0];
				break;
		}

		this.currentNote = note;
		this.displayNote(note);
	}

	async displayNote(note: TFile) {
		const {contentEl} = this;
		contentEl.empty();

		const titleEl = contentEl.createEl('h2', {text: note.basename, cls: 'sorteeer-note-title'});
		
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

		const content = await this.app.vault.read(note);
		const noteContent = contentEl.createDiv('note-content');
		await MarkdownRenderer.renderMarkdown(content, noteContent, note.path, this.plugin);

		const actionBar = contentEl.createDiv('action-bar');
		this.createActionButton(actionBar, 'Delete', this.plugin.settings.deleteAction, () => this.deleteNote());
		this.createActionButton(actionBar, 'Move', this.plugin.settings.moveAction, () => this.moveNote());
		this.createActionButton(actionBar, 'More', 'More Actions', () => this.showMoreActions());
	}

	createActionButton(container: HTMLElement, text: string, tooltip: string, callback: () => void) {
		const button = container.createEl('button', {text: text});
		button.title = tooltip;
		button.addEventListener('click', callback);
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
				new Notice('Sorteeer: Invalid move folder');
			}
		}
	}

	showMoreActions() {
		const modal = new MoreActionsModal(this.app, this.plugin, this);
		modal.open();
	}
}

class MoreActionsModal extends Modal {
	plugin: SorteeerPlugin;
	parentModal: SorteeerModal;

	constructor(app: App, plugin: SorteeerPlugin, parentModal: SorteeerModal) {
		super(app);
		this.plugin = plugin;
		this.parentModal = parentModal;
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('sorteeer-more-actions');

		this.createActionButton('Remove Tag', () => this.removeTag());
		this.createActionButton('Add Tag', () => this.addTag());
		this.createActionButton('Add Star', () => this.addStar());
		this.createActionButton('Add Link', () => this.addLink());
	}

	createActionButton(text: string, callback: () => void) {
		const button = this.contentEl.createEl('button', {text: text});
		button.addEventListener('click', () => {
			callback();
			this.close();
		});
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
				.setValue(this.plugin.settings.sortOrder)
				.onChange(async (value: 'random' | 'oldest' | 'newest') => {
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
	}
}
