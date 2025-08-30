import * as vscode from 'vscode';
import axios from 'axios';
import { ErrorTreeDataProvider } from './ErrorTreeDataProvider.js';
import { AIChatDataProvider } from './AIChatDataProvider.js';
import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';

const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY";
const MURF_API_KEY = "YOUR_MURF_SPI_KEY";

export async function activate(context) {
    const errorProvider = new ErrorTreeDataProvider();
    vscode.window.createTreeView('aiErrorHelperView', { treeDataProvider: errorProvider });

    const aiChatProvider = new AIChatDataProvider();
    vscode.window.createTreeView('aiChatView', { treeDataProvider: aiChatProvider });

    context.subscriptions.push(
        vscode.commands.registerCommand('ai-chat.openPanel', () => openChatPanel(context, aiChatProvider))
    );

    // === NEW: send message in chat tree ===
    context.subscriptions.push(
        vscode.commands.registerCommand('ai-chat.sendMessage', async () => {
            const userInput = await vscode.window.showInputBox({ prompt: "Ask AI something..." });
            if (!userInput) return;
            aiChatProvider.addMessage("user", userInput);
            try {
                const res = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
                    { contents: [{ parts: [{ text: userInput }] }] },
                    { headers: { "Content-Type": "application/json" } }
                );
                const reply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
                aiChatProvider.addMessage("ai", reply);
            } catch (err) {
                console.error("AI Chat Error:", err.response?.data || err.message);
                aiChatProvider.addMessage("ai", "❌ Failed to fetch AI reply.");
            }
        })
    );

    const updateSidebar = () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            errorProvider.refresh([]);
            return;
        }

        const diagnostics = vscode.languages.getDiagnostics(activeEditor.document.uri)
            .filter(d => d.severity === vscode.DiagnosticSeverity.Error);

        const existingSolutions = new Map();
        for (const error of errorProvider.errors) {
            if (error.solution) {
                const errorKey = `${error.diagnostic.message}|${error.diagnostic.range.start.line}`;
                existingSolutions.set(errorKey, error.solution);
            }
        }

        const newErrorInfos = diagnostics.map(diagnostic => {
            const errorKey = `${diagnostic.message}|${diagnostic.range.start.line}`;
            return {
                diagnostic,
                document: activeEditor.document,
                solution: existingSolutions.get(errorKey) || null
            };
        });

        errorProvider.refresh(newErrorInfos);
    };

    context.subscriptions.push(
        vscode.languages.onDidChangeDiagnostics(updateSidebar),
        vscode.window.onDidChangeActiveTextEditor(updateSidebar)
    );

    updateSidebar();

    const disposableGetExplanation = vscode.commands.registerCommand('ai-error-helper.getExplanation', async (errorInfo) => {
        if (!errorInfo) return;

        const errorKey = `${errorInfo.diagnostic.message}|${errorInfo.diagnostic.range.start.line}`;
        const errorToUpdate = errorProvider.errors.find(
            e => `${e.diagnostic.message}|${e.diagnostic.range.start.line}` === errorKey
        );

        if (!errorToUpdate) return;

        errorToUpdate.solution = "⏳ Explanation loading..., please wait a moment...";
        errorProvider.refresh(errorProvider.errors);

        try {
            const { diagnostic, document } = errorInfo;
            const codeLine = document.lineAt(diagnostic.range.start.line).text;

            const prompt = `Explain this error to me like a good friend like a story, in about 1000 - 1100 letters, so I can quickly understand it:
            Error: "${diagnostic.message}" 
            Code line: "${codeLine}"`;

            const geminiRes = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
                { contents: [{ parts: [{ text: prompt }] }] },
                { headers: { "Content-Type": "application/json" } }
            );

            let solutionText =
                geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
                "💡 AI Solution unavailable.";

            // clean markdown
            solutionText = solutionText
                // Fences like ```js ... ```
                .replace(/```[a-z0-9+#-]*\n?([\s\S]*?)```/gi, "$1")
                // **bold**
                .replace(/\*\*(.*?)\*\*/g, "$1")
                // __underline__
                .replace(/__(.*?)__/g, "$1")
                // `inline code`
                .replace(/`([^`]*)`/g, "$1")
                // remove standalone C++ mentions
                .replace(/\bC\+\+\b/gi, "")
                // collapse multiple spaces/newlines
                .replace(/\s+/g, " ")
                .trim();

            errorToUpdate.solution = solutionText;
            errorProvider.refresh(errorProvider.errors);

            vscode.commands.executeCommand('ai-error-helper.showSolutionWebview', solutionText);
        } catch (err) {
            console.error("Failed to get AI solution:", err.response?.data || err.message);
            errorToUpdate.solution = "❌ Failed to get AI solution. Check Debug Console.";
            errorProvider.refresh(errorProvider.errors);
        }
    });


    const disposablePlayVoiceExplanation = vscode.commands.registerCommand(
        'ai-error-helper.playVoiceExplanation',
        async (errorInfo) => {
            if (!errorInfo) return;

            try {
                const { diagnostic, document } = errorInfo;
                const codeLine = document.lineAt(diagnostic.range.start.line).text;

                const prompt = `Explain this error in simple friendly words like a short story so I can quickly understand:
Error: "${diagnostic.message}"
Code line: "${codeLine}"`;

                const geminiRes = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
                    { contents: [{ parts: [{ text: prompt }] }] },
                    { headers: { "Content-Type": "application/json" } }
                );

                let solutionText = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || "No explanation available.";
                solutionText = solutionText
                    // Fences like ```js ... ```
                    .replace(/```[a-z0-9+#-]*\n?([\s\S]*?)```/gi, "$1")
                    // **bold**
                    .replace(/\*\*(.*?)\*\*/g, "$1")
                    // __underline__
                    .replace(/__(.*?)__/g, "$1")
                    // `inline code`
                    .replace(/`([^`]*)`/g, "$1")
                    // remove standalone C++ mentions
                    .replace(/\bC\+\+\b/gi, "")
                    // collapse multiple spaces/newlines
                    .replace(/\s+/g, " ")
                    .trim();


                vscode.window.setStatusBarMessage("🔊 Generating voice explanation...", 2000);
                const ttsRes = await axios.post(
                    "https://api.murf.ai/v1/speech/generate",
                    {
                        text: solutionText,
                        voice_id: "en-IN-eashwar",
                        style: "Promo"
                    },
                    {
                        headers: {
                            "Content-Type": "application/json",
                            Accept: "application/json",
                            "api-key": MURF_API_KEY
                        }
                    }
                );

                const audioUrl = ttsRes.data?.audioFile || ttsRes.data?.audio_url;
                if (audioUrl) {
                    vscode.env.openExternal(vscode.Uri.parse(audioUrl));
                } else {
                    vscode.window.showErrorMessage("❌ Failed to fetch audio URL from Murf.");
                    console.error("Murf response without audio URL:", ttsRes.data);
                }
            } catch (err) {
                console.error("Voice Explanation Error:", err.response?.data || err.message);
                vscode.window.showErrorMessage("❌ Failed to generate voice explanation.");
            }
        }
    );

    const disposableShowWebview = vscode.commands.registerCommand(
        'ai-error-helper.showSolutionWebview',
        (solution, errorMessage) => {
            const tabTitle = errorMessage ? `Error: ${errorMessage.substring(0, 50)}` : 'Error';

            const escapeHtml = (unsafe) => unsafe
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");

            const solutionForHtmlDisplay = escapeHtml(solution);
            const solutionForTTS = JSON.stringify(solution);

            const panel = vscode.window.createWebviewPanel(
                'aiSolution',
                tabTitle,
                vscode.ViewColumn.One, {
                enableScripts: true,
                retainContextWhenHidden: true
            }
            );

            panel.webview.html = `
            <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(tabTitle)}</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap" rel="stylesheet">
<style>
    body {
        font-family: 'Poppins', sans-serif;
        margin: 0;
        background: linear-gradient(135deg, #0d0d10, #1a1a1f);
        color: #e4e6eb;
        line-height: 1.8;
        display: flex;
        justify-content: center;
        align-items: center;
        min-height: 100vh;
    }
    .container {
        max-width: 800px;
        width: 100%;
        max-height: 70vh;
        overflow-y: auto;
        padding: 24px 28px;
        background: rgba(255, 255, 255, 0.03);
        border-radius: 14px;
        backdrop-filter: blur(12px);
        box-shadow: 0 8px 24px rgba(0,0,0,0.6);
        white-space: pre-wrap;
        word-wrap: break-word;
        font-size: 15px;
        border: 1px solid rgba(255,255,255,0.08);
        transition: all 0.3s ease;
        display: flex;
        flex-direction: column;
         gap: 12px;
    }

    #speakBtn, #downloadPdfBtn {
        display: inline-block;
        margin-right: 8px;
        padding: 8px 14px;
        border-radius: 6px;
        border: none;
        cursor: pointer;
        background: #4cafef;
        color: white;
        font-size: 14px;
        transition: 0.3s ease;
    }

    #speakBtn:hover, #downloadPdfBtn:hover {
        background: #0077cc;
    }


    h1, h2, h3 {
        color: #4dabf7;
        margin-bottom: 14px;
        font-weight: 600;
    }
    button {
        padding: 12px 24px;
        font-size: 15px;
        font-weight: 500;
        border: none;
        border-radius: 10px;
        background: linear-gradient(135deg, #4dabf7, #1864ab);
        color: #fff;
        cursor: pointer;
        transition: all 0.25s ease;
        box-shadow: 0 4px 14px rgba(0,0,0,0.3);
        margin-top: 14px;
        display: block;
    }
    button:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 18px rgba(0,0,0,0.5);
        background: linear-gradient(135deg, #5cb6ff, #1a6fc2);
    }
    #audio-player-container {
        margin-top: 20px;
        display: flex;
        justify-content: center;
        width: 100%;
    }
    audio {
        width: 100%;
        max-width: 680px;
        height: 48px;
        border-radius: 12px;
        background: #141418;
        box-shadow: 0 4px 14px rgba(0,0,0,0.4), inset 0 0 6px rgba(255,255,255,0.05);
        outline: none;
        -webkit-appearance: none;
        appearance: none;
    }
    audio::-webkit-media-controls-panel {
        background: #141418;
        border-radius: 12px;
    }
    audio::-webkit-media-controls-play-button,
    audio::-webkit-media-controls-mute-button {
        filter: invert(90%) hue-rotate(180deg);
    }
    audio::-webkit-media-controls-timeline,
    audio::-webkit-media-controls-current-time-display,
    audio::-webkit-media-controls-time-remaining-display,
    audio::-webkit-media-controls-volume-slider {
        filter: invert(80%) hue-rotate(180deg);
    }
    .container::-webkit-scrollbar { width: 8px; }
    .container::-webkit-scrollbar-thumb { background: #3b82f6; border-radius: 6px; }
    .container::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); }

    .loading-box {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 14px;
        padding: 40px 28px;
        border-radius: 16px;
        background: rgba(77,171,247,0.08);
        border: 1px solid rgba(77,171,247,0.25);
        font-weight: 600;
        font-size: 16px;
        color: #4dabf7;
        box-shadow: 0 0 18px rgba(77,171,247,0.25);
        text-align: center;
        min-height: 180px;
    }
    .dots {
        display: flex;
        gap: 6px;
    }
    .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #4dabf7;
        animation: blink 1.4s infinite;
    }
    .dot:nth-child(2) { animation-delay: 0.2s; }
    .dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes blink {
        0%, 80%, 100% { opacity: 0.3; transform: scale(0.9); }
        40% { opacity: 1; transform: scale(1.2); }
    }

    .voice-select {
    width: 100%;
    padding: 10px 14px;
    margin: 12px 0;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: rgba(255, 255, 255, 0.07);
    backdrop-filter: blur(8px);
    color: #fff;
    font-size: 15px;
    font-weight: 500;
    outline: none;
    cursor: pointer;
    transition: all 0.3s ease;
}

.voice-select:hover,
.voice-select:focus {
    border-color: #4e9eff;
    background: rgba(255, 255, 255, 0.12);
    box-shadow: 0 0 12px rgba(78, 158, 255, 0.4);
}

.voice-select option {
    background: #1c1c1c;
    color: #fff;
    padding: 10px;
    font-size: 14px;
}

</style>
</head>
<body>
<div>
    <div class="container" id="solution-container">${solutionForHtmlDisplay}</div>
            <div>
                <select id="voiceSelect" class="voice-select" >
                    <option value="en-IN-aarav">Aarav (Male, Indian)</option>
                    <option value="en-IN-priya">Priya (Female, Indian)</option>
                    <option value="en-US-natalie">Natalie (Female, US)</option>
                    <option value="en-US-marcus">Marcus (Male, US)</option>
                    <option value="en-UK-freddie">Freddie (Male, British)</option>
                </select>

                <select id="styleSelect" class="voice-select">
                    <option value="default">Default Style</option>
                    <option value="conversational">Conversational</option>
                    <option value="promo">Promo</option>
                    <option value="narration">Narration</option>
                </select>
            </div>
            <div style="display: flex; gap: 10px; width: 100%; margin-top: 10px;">
    <button id="speakBtn" style="flex: 1; padding: 10px; font-size: 14px; cursor: pointer; border-radius: 6px; border: none; background: #007bff; color: white;">
        🔊 Explain in Voice
    </button>
    <button id="downloadPdfBtn" style="flex: 1; padding: 10px; font-size: 14px; cursor: pointer; border-radius: 6px; border: none; background: #28a745; color: white;">
        📥 Download as PDF
    </button>
</div>

    <div id="audio-player-container"></div>
</div>
<script>
    const vscode = acquireVsCodeApi();
    const speakBtn = document.getElementById('speakBtn');
    const style = document.getElementById("styleSelect").value;
    const downloadPdfBtn = document.getElementById('downloadPdfBtn');
    const solutionContainer = document.getElementById('solution-container');
    const textToSpeak = ${solutionForTTS};

    
    // 🚀 Replace boring loading text with styled loader
    if (solutionContainer.innerText.includes("⏳ Explanation loading")) {
        solutionContainer.innerHTML = \`
            <div class="loading-box">
                <div>⏳ Explanation loading...</div>
                <div class="dots">
                    <div class="dot"></div>
                    <div class="dot"></div>
                    <div class="dot"></div>
                </div>
            </div>\`;
        speakBtn.style.display = "none";
        downloadPdfBtn.style.display = "none";
        document.getElementById("voiceSelect").style.display = "none"; // 👈 hide voice
        document.getElementById("styleSelect").style.display = "none"; // 👈 hide style
    }

downloadPdfBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'downloadPdf', text: solutionContainer.innerText });
    });

    speakBtn.addEventListener('click', () => {
    const selectedVoice = voiceSelect.value; // 👈 selected voice
      const selectedStyle = document.getElementById("styleSelect").value;
    speakBtn.innerText = '🔊 Generating...';
    speakBtn.disabled = true;
    document.getElementById('audio-player-container').innerHTML = '';
    vscode.postMessage({ 
            command: 'speak', 
            text: textToSpeak, 
            voice: selectedVoice,
            style: selectedStyle  
        });
    });

    window.addEventListener('message', event => {
        const message = event.data;
        if (message.command === 'explanationLoaded') {
        speakBtn.style.display = "inline-block";
        downloadPdfBtn.style.display = "inline-block";
        document.getElementById("voiceSelect").style.display = "block"; // 👈 show voice dropdown
        document.getElementById("styleSelect").style.display = "block"; // 👈 show style dropdown
    }
        switch (message.command) {
            case 'speechFinished':
                speakBtn.innerText = '🔊 Explain in Voice';
                speakBtn.disabled = false;
                speakBtn.style.display = "inline-block";
                break;
            case 'playAudio':
                const playerContainer = document.getElementById('audio-player-container');
                playerContainer.innerHTML = "";
                const audioPlayer = document.createElement('audio');
                audioPlayer.src = message.url;
                audioPlayer.controls = true;
                audioPlayer.autoplay = true;
                playerContainer.appendChild(audioPlayer);
                speakBtn.style.display = "inline-block";
                break;
        }
    });
</script>
</body>
</html>
`;




            panel.webview.onDidReceiveMessage(async (message) => {
                if (message.command === 'speak' && message.text) {
                    try {
                        vscode.window.showInformationMessage("Generating audio...");

                        const response = await axios.post(
                            "https://api.murf.ai/v1/speech/generate", {
                            text: message.text,
                            voice_id: message.voice || "en-IN-eashwar", 
                            style: message.style || "Conversational"
                        }, {
                            headers: {
                                "Content-Type": "application/json",
                                "Accept": "application/json",
                                "api-key": MURF_API_KEY
                            }
                        });

                        const audioUrl = response.data?.audioFile;
                        if (!audioUrl) {
                            console.error("Full response from Murf:", JSON.stringify(response.data, null, 2));
                            throw new Error("Murf API response did not contain an 'audioFile' key.");
                        }

                        panel.webview.postMessage({ command: 'playAudio', url: audioUrl });
                    } catch (err) {
                        console.error("Murf TTS Error:", err.response?.data || err.message);
                        vscode.window.showErrorMessage("Failed to play TTS. Check the Debug Console for details.");
                    } finally {
                        panel.webview.postMessage({ command: 'speechFinished' });
                    }
                }

                if (message.command === 'downloadPdf' && message.text) {
                    try {
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        const folderPath = workspaceFolders ? workspaceFolders[0].uri.fsPath : require('os').homedir();
                        const filePath = path.join(folderPath, "explanation.pdf");

                        const doc = new PDFDocument();
                        const stream = fs.createWriteStream(filePath);
                        doc.pipe(stream);
                        doc.fontSize(14).text(message.text, { align: "left" });
                        doc.end();

                        stream.on("finish", () => {
                            vscode.window.showInformationMessage(`✅ PDF saved: ${filePath}`);
                            vscode.env.openExternal(vscode.Uri.file(filePath)); // auto-open
                        });
                    } catch (err) {
                        console.error("PDF Generation Error:", err);
                        vscode.window.showErrorMessage("❌ Failed to generate PDF");
                    }
                }
            });
        }
    );

    context.subscriptions.push(
        disposableGetExplanation,
        disposablePlayVoiceExplanation,
        disposableShowWebview
    );
}

export function openChatPanel(context, aiChatProvider) {
    const panel = vscode.window.createWebviewPanel(
        "aiChatPanel",
        "CodeWhisper",
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = getChatHtml();

    // Handle chat events from webview
    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === "chat:send") {
            const text = `${message.text || ""}`.trim();
            if (!text) return;

            aiChatProvider.addMessage("user", text);

            try {
                // Gemini API call
                const res = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
                    { contents: [{ parts: [{ text }] }] },
                    { headers: { "Content-Type": "application/json" } }
                );

                const reply =
                    res.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
                    "No response.";
                aiChatProvider.addMessage("ai", reply);

                panel.webview.postMessage({
                    command: "chat:append",
                    role: "ai",
                    text: reply,
                });
            } catch (e) {
                const errText = "❌ Failed to fetch AI reply.";
                console.error("AI Chat Panel Error:", e.response?.data || e.message);
                aiChatProvider.addMessage("ai", errText);
                panel.webview.postMessage({
                    command: "chat:append",
                    role: "ai",
                    text: errText,
                });
            }
        }

        if (message.command === "chat:tts") {
            try {
                const res = await axios.post(
                    "https://api.murf.ai/v1/speech/generate",
                    {
                        text: message.text,
                        voice_id: "en-IN-eashwar",
                        style: "Promo",
                    },
                    {
                        headers: {
                            "Content-Type": "application/json",
                            Accept: "application/json",
                            "api-key": MURF_API_KEY,
                        },
                    }
                );

                const audioUrl = res.data?.audioFile || res.data?.audio_url;
                if (audioUrl) {
                    panel.webview.postMessage({
                        command: "chat:playAudio",
                        url: audioUrl,
                    });
                } else {
                    console.error("No audio URL in Murf response:", res.data);
                }
            } catch (err) {
                console.error("Murf TTS Error:", err.response?.data || err.message);
            }
        }
    });
}

function getChatHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&family=Montserrat:wght@600&display=swap" rel="stylesheet">
<style>
:root {
    --bg: #0d0f14;
    --chat-bg: #181a20;
    --header-bg: #111318;
    --user-bg: linear-gradient(135deg,#0b74ff,#1a91ff);
    --user-color: #fff;
    --ai-bg: #2c2f38;
    --ai-color: #e6edf3;
    --input-bg: #1f2128;
    --input-border: #444c5c;
}
* { box-sizing: border-box; margin:0; padding:0; }
body {
    font-family: 'Poppins', sans-serif;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: #e6edf3;
}

/* 🔹 Header Bar */
#header {
    background: var(--header-bg);
    padding: 16px 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Montserrat', sans-serif;
    font-weight: 600;
    font-size: 18px;
    letter-spacing: 0.5px;
    color: #4dabf7;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    box-shadow: 0 2px 8px rgba(0,0,0,0.6);
    position: sticky;
    top: 0;
    z-index: 10;
}

/* 🔹 Chat Window */
#chat {
    flex: 1;
    overflow-y: auto;
    padding: 22px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    scroll-behavior: smooth;
    background: var(--chat-bg);
    border-radius: 24px 24px 0 0;
    margin: 0 12px;
    box-shadow: inset 0 0 20px rgba(0,0,0,0.5);
}
.row { display: flex; flex-direction: column; }
.msg {
    max-width: 75%;
    padding: 14px 18px;
    border-radius: 18px;
    line-height: 1.6;
    word-wrap: break-word;
    box-shadow: 0 4px 14px rgba(0,0,0,0.5);
    margin: 2px 0;
    font-size: 15px;
    animation: fadeIn 0.3s ease;
}
.user { 
    align-self: flex-end;
    background: var(--user-bg); 
    color: var(--user-color); 
    border-bottom-right-radius: 6px;
}
.ai { 
    align-self: flex-start; 
    background: var(--ai-bg); 
    color: var(--ai-color); 
    border-bottom-left-radius: 6px;
}
.meta { 
    font-size: 12px; 
    margin-bottom: 6px; 
    opacity: 0.75; 
}
pre {
    margin: 0;
    font-family: monospace;
    white-space: pre-wrap;
}
.read-btn {
    margin-top: 8px;
    font-size: 13px;
    cursor: pointer;
    color: #4dabf7;
    text-decoration: underline;
    transition: color 0.2s ease;
}
.read-btn:hover { color: #6dbfff; }

/* 🔹 Composer (Message box) */
#composer {
    display: flex;
    padding: 14px 16px;
    gap: 10px;
    background: var(--chat-bg);
    border-radius: 0 0 20px 20px;
    margin: 0 12px 14px 12px;
    align-items: center;
    box-shadow: 0 -4px 16px rgba(0,0,0,0.5);
}
#input {
    flex: 1;
    border-radius: 16px;
    padding: 10px 14px;
    border: 1px solid var(--input-border);
    outline: none;
    font-family: 'Poppins', sans-serif;
    resize: vertical;
    max-height: 120px;
    background: var(--input-bg);
    color: #e6edf3;
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
#input:focus { 
    border-color: #0b74ff; 
    box-shadow: 0 0 6px rgba(11,116,255,0.4); 
}
button {
    padding: 0 18px;
    height: 42px;
    border-radius: 9999px;
    border: none;
    background: #0b74ff;
    color: white;
    cursor: pointer;
    font-size: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.2s ease, background 0.2s ease;
}
button:hover { 
    background: #005ecb; 
    transform: translateY(-2px) scale(1.05); 
}

/* Animations */
@keyframes fadeIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
}
</style>
</head>
<body>
<div id="header">✨ Your Personal Doubt Clearer ✨</div>
<div id="chat"></div>
<div id="composer">
    <textarea id="input" placeholder="Type your doubt…"></textarea>
    <button id="send">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" 
        viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" 
        stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
    </button>
</div>
<audio id="player" controls style="display:none;"></audio>
    <script>
        const vscode = acquireVsCodeApi();
        const chat = document.getElementById('chat');
        const input = document.getElementById('input');
        const sendBtn = document.getElementById('send');
        const player = document.getElementById('player');

        function append(role, text, typing=false) {
            const row = document.createElement('div');
            row.className = 'row';

            const bubble = document.createElement('div');
            bubble.className = 'msg ' + (role==='user' ? 'user' : 'ai');

            const meta = document.createElement('div');
            meta.className = 'meta';
            meta.textContent = role==='user' ? '🧑 You' : '🤖 CodeWhisper';

            const body = document.createElement('div');
            const pre = document.createElement('pre');
            body.appendChild(pre);
            bubble.appendChild(meta);
            bubble.appendChild(body);

            if(role === 'ai'){
                const readBtn = document.createElement('div');
                readBtn.className = 'read-btn';
                readBtn.textContent = '🔊 Read';
                readBtn.addEventListener('click', ()=> {
                    vscode.postMessage({command:'chat:tts', text});
                });
                bubble.appendChild(readBtn);
            }

            row.appendChild(bubble);
            chat.appendChild(row);
            chat.scrollTop = chat.scrollHeight;

            if(typing && role==='ai') {
                typeWriter(pre, text);
            } else {
                pre.textContent = text;
            }
        }

        function typeWriter(element, text, i=0) {
            if(i===0){ element.textContent=''; }
            if(i<text.length){
                setTimeout(() => {
                    element.textContent+=text.charAt(i);
                    typeWriter(element, text, i+1);
                    chat.scrollTop = chat.scrollHeight;
                }, 18);
            }
        }

        input.addEventListener('keydown', e=>{
            if(e.key==='Enter' && !e.shiftKey){
                e.preventDefault();
                sendMessage();
            }
        });
        sendBtn.addEventListener('click', sendMessage);

        function sendMessage(){
            const text=input.value.trim();
            if(!text) return;
            vscode.postMessage({command:'chat:send', text});
            append('user', text);
            input.value='';
        }

        window.addEventListener('message', e=>{
            const {command} = e.data||{};
            if(command==='chat:append'){
                append(e.data.role, e.data.text, e.data.role==='ai');
            }
            if(command==='chat:playAudio'){
                player.src = e.data.url;
                player.play();
            }
        });
</script>
</body>
</html>`;
}

export function deactivate() { }