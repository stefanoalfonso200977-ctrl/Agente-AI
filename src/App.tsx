/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { auth, db } from './firebase';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged } from 'firebase/auth';
import ReactMarkdown from 'react-markdown';
import { GoogleGenAI } from "@google/genai";
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min?url';
import { Bot } from 'lucide-react';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export default function App() {
  const [user, setUser] = useState(auth.currentUser);
  const [messages, setMessages] = useState<{role: 'user' | 'assistant', content: string}[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [fileData, setFileData] = useState<{content: string, type: string, name: string} | null>(null);
  const [useFallback, setUseFallback] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
    });
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login failed", error);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    setLoading(true);
    let extractedText = '';

    try {
      if (file.type === 'application/pdf') {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          extractedText += textContent.items.map((item: any) => item.str).join(' ');
        }
      } else if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        extractedText = result.value;
      } else if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const base64 = e.target?.result as string;
          setFileData({ content: base64, type: file.type, name: file.name });
        };
        reader.readAsDataURL(file);
        setLoading(false);
        return;
      }
      
      // Truncate text for Firestore to avoid 1MB limit (approx 800,000 chars to be safe)
      const MAX_CHARS = 800000;
      const textToSave = extractedText.length > MAX_CHARS 
        ? extractedText.substring(0, MAX_CHARS) + '\n\n[Testo troncato nel database per limiti di spazio]'
        : extractedText;

      // Save to Firestore
      await addDoc(collection(db, 'documents'), {
        ownerUid: user.uid,
        content: textToSave,
        fileName: file.name,
        createdAt: serverTimestamp()
      });
      
      setFileData({ content: extractedText, type: file.type, name: file.name });
    } catch (error) {
      console.error("File processing error", error);
      alert("Errore durante l'elaborazione del file. Potrebbe essere troppo grande o danneggiato.");
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async () => {
    if (!input.trim() && !fileData) return;
    
    let contents: any = input;
    if (fileData) {
      if (fileData.type.startsWith('image/')) {
        contents = [
          { inlineData: { mimeType: fileData.type, data: fileData.content.split(',')[1] } },
          { text: input }
        ];
      } else {
        const fallbackInstruction = useFallback 
          ? "Istruzioni: Rispondi alla domanda usando le informazioni fornite nel contesto. Se la risposta non è presente nel contesto, usa la tua conoscenza generale per rispondere, ma specifica chiaramente che l'informazione non proviene dal documento caricato."
          : "Istruzioni: Rispondi alla domanda usando ESCLUSIVAMENTE le informazioni fornite nel contesto. Se la risposta non è presente nel contesto, rispondi esattamente con 'Non ho trovato la risposta nel documento caricato.' Non usare conoscenze esterne al documento.";
        
        contents = `Contesto: ${fileData.content}\n\nDomanda: ${input}\n\n${fallbackInstruction}`;
      }
    }

    const userMessage = { role: 'user' as const, content: input + (fileData ? ` (File: ${fileData.name})` : '') };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    let retries = 3;
    let delay = 1000;

    while (retries > 0) {
      try {
        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: contents,
        });
        setMessages(prev => [...prev, { role: 'assistant', content: response.text || '' }]);
        break;
      } catch (error: any) {
        const errorMessage = error.message || JSON.stringify(error);
        const isQuota = errorMessage.includes('quota') || errorMessage.includes('billing');
        const isRateLimit = (errorMessage.includes('429') || error.code === 429) && !isQuota;
        
        if (isRateLimit && retries > 1) {
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
          retries--;
        } else {
          console.error("Gemini error", error);
          const displayMessage = isQuota 
            ? "Errore: Hai superato la quota massima di utilizzo delle API di Gemini. Attendi qualche minuto o controlla il tuo piano."
            : "Errore: Si è verificato un problema con l'API di Gemini.";
          setMessages(prev => [...prev, { role: 'assistant', content: displayMessage }]);
          break;
        }
      }
    }
    setLoading(false);
    setFileData(null);
  };

  return (
    <div className="flex flex-col h-screen bg-zinc-50">
      <header className="p-4 bg-red-600 text-white flex justify-between items-center shadow-md">
        <div className="flex items-center gap-2">
          <Bot className="w-6 h-6" />
          <h1 className="text-xl font-bold">Agente AI</h1>
        </div>
        {user ? (
          <div className="flex items-center gap-4">
            <span className="text-sm text-red-100">{user.email}</span>
            <button onClick={() => auth.signOut()} className="text-sm font-medium bg-white text-red-600 px-3 py-1 rounded-md hover:bg-red-50 transition-colors">Logout</button>
          </div>
        ) : (
          <button onClick={handleLogin} className="px-4 py-2 bg-white text-red-600 font-medium rounded-lg text-sm hover:bg-red-50 transition-colors">
            Login
          </button>
        )}
      </header>
      <main className="flex-1 p-4 overflow-y-auto">
        {user ? (
          <div className="space-y-4">
            {messages.map((m, i) => (
              <div key={i} className={`p-3 rounded-lg ${m.role === 'user' ? 'bg-blue-100 ml-auto' : 'bg-white'}`}>
                <ReactMarkdown>{m.content}</ReactMarkdown>
              </div>
            ))}
            {loading && <div className="p-3 bg-white rounded-lg">Sto elaborando...</div>}
          </div>
        ) : (
          <div className="text-center mt-20">Effettua il login per iniziare.</div>
        )}
      </main>
      {user && (
        <footer className="p-4 border-t bg-white flex flex-col gap-2">
          {fileData && !fileData.type.startsWith('image/') && (
            <label className="flex items-center gap-2 text-sm text-zinc-600 self-start">
              <input 
                type="checkbox" 
                checked={useFallback} 
                onChange={(e) => setUseFallback(e.target.checked)} 
                className="rounded"
              />
              Usa conoscenza generale se non trovi la risposta nel file
            </label>
          )}
          <div className="flex gap-2">
            <input 
              type="file" 
              className="hidden" 
              id="file-upload" 
              onChange={handleFileChange}
              accept=".pdf,.docx,image/*"
            />
            <label htmlFor="file-upload" className="p-2 border rounded-lg cursor-pointer">📎</label>
            <input 
              value={input} 
              onChange={(e) => setInput(e.target.value)}
              className="flex-1 p-2 border rounded-lg"
              placeholder={fileData ? `File ${fileData.name} caricato!` : "Chiedi qualcosa..."}
              onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            />
            <button onClick={handleSend} disabled={loading} className="px-4 py-2 bg-blue-600 text-white rounded-lg">Invia</button>
          </div>
        </footer>
      )}
    </div>
  );
}
