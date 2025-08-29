import * as vscode from 'vscode';

export class ErrorTreeDataProvider {
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor() {
        this.errors = [];
    }

    refresh(errors = []) {
        this.errors = errors;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element) {
        return element;
    }

    getChildren(element) {
        if (!element) {
            return this.errors.map(errorInfo => {
                const item = new vscode.TreeItem(
                    errorInfo.diagnostic.message,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.description = `L${errorInfo.diagnostic.range.start.line + 1}`;
                item.tooltip = "Expand to get an AI solution";
                item.errorInfo = errorInfo;
                return item;
            });
        }

        const errorInfo = element.errorInfo;
        const children = [];

        if (errorInfo.solution) {
            // Show one TreeItem that opens Webview for formatted solution
            const solutionItem = new vscode.TreeItem(
                "🤖 Click to see Explanation",
                vscode.TreeItemCollapsibleState.None
            );

            solutionItem.command = {
                command: 'ai-error-helper.showSolutionWebview',
                title: 'Show AI Solution',
                arguments: [errorInfo.solution]
            };

            solutionItem.tooltip = "Click to directly listen to the explanation";
            children.push(solutionItem);

            // 🔊 Add Voice Explanation option
            const voiceItem = new vscode.TreeItem(
                "🔊 Voice Explanation",
                vscode.TreeItemCollapsibleState.None
            );
            voiceItem.command = {
                command: 'ai-error-helper.playVoiceExplanation',
                title: 'Play Voice Explanation',
                arguments: [errorInfo.solution]
            };
            voiceItem.tooltip = "Click to listen Explanation";
            children.push(voiceItem);

        } else {
            const getSolutionItem = new vscode.TreeItem(
                "🤖 Get Error Explanation",
                vscode.TreeItemCollapsibleState.None
            );
            getSolutionItem.command = {
                command: 'ai-error-helper.getExplanation',
                title: 'Get AI Explanation',
                arguments: [errorInfo]
            };
            getSolutionItem.tooltip = "Click to get Error Explanation.";
            children.push(getSolutionItem);

            const voiceItem = new vscode.TreeItem(
                "🔊 Voice Explanation",
                vscode.TreeItemCollapsibleState.None
            );
            voiceItem.command = {
                command: 'ai-error-helper.playVoiceExplanation',
                title: 'Play Voice Explanation',
                arguments: [errorInfo] // still pass errorInfo, can fetch + speak
            };
            voiceItem.tooltip = "Click to directly listen to the explanation";
            children.push(voiceItem);
        }

        return children;
    }
}
