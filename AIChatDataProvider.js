import * as vscode from 'vscode';

export class AIChatDataProvider {
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor() {
        this.messages = [];
    }

    refresh(messages = []) {
        this.messages = messages;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element) {
        return element;
    }

    getChildren() {
        return this.messages.map(msg => {
            const prefix = msg.role === "user" ? "🧑" : "🤖";
            const item = new vscode.TreeItem(
                `${prefix} ${msg.text}`,
                vscode.TreeItemCollapsibleState.None
            );
            return item;
        });
    }

    addMessage(role, text) {
        this.messages.push({ role, text });
        this.refresh(this.messages);
    }
}
