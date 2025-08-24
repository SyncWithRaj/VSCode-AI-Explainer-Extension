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
                "🤖 AI Solution",
                vscode.TreeItemCollapsibleState.None
            );

            solutionItem.command = {
                command: 'ai-error-helper.showSolutionWebview',
                title: 'Show AI Solution',
                arguments: [errorInfo.solution]
            };

            solutionItem.tooltip = "Click to view formatted AI solution";
            children.push(solutionItem);
        } else {
            const getSolutionItem = new vscode.TreeItem(
                "🤖 Get AI Solution",
                vscode.TreeItemCollapsibleState.None
            );
            getSolutionItem.command = {
                command: 'ai-error-helper.getExplanation',
                title: 'Get AI Explanation',
                arguments: [errorInfo]
            };
            getSolutionItem.tooltip = "Click to call the Gemini API for an explanation";
            children.push(getSolutionItem);
        }

        return children;
    }
}
