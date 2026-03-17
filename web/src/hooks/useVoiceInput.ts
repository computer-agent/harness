import { useCallback, useEffect, useRef, useState } from "react";
import i18n from "@/lib/i18n";

interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

export function useVoiceInput() {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<InstanceType<typeof SpeechRecognition> | null>(null);

  const SpeechRecognitionCtor =
    typeof window !== "undefined"
      ? ((window as unknown as Record<string, unknown>).SpeechRecognition ??
        (window as unknown as Record<string, unknown>).webkitSpeechRecognition)
      : null;

  const isSupported = !!SpeechRecognitionCtor;

  const startListening = useCallback(() => {
    if (!SpeechRecognitionCtor) {
      setError("notSupported");
      return;
    }

    try {
      const recognition = new (SpeechRecognitionCtor as new () => SpeechRecognition)();
      recognition.lang = i18n.language === "pt-BR" ? "pt-BR" : "en-US";
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let final = "";
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) {
            final += result[0].transcript;
          } else {
            interim += result[0].transcript;
          }
        }
        if (final) setTranscript((prev) => prev + final);
        setInterimTranscript(interim);
      };

      recognition.onerror = (event: { error: string }) => {
        if (event.error === "not-allowed") {
          setError("micDenied");
        }
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
        setInterimTranscript("");
      };

      recognitionRef.current = recognition;
      recognition.start();
      setIsListening(true);
      setTranscript("");
      setInterimTranscript("");
      setError(null);
    } catch {
      setError("notSupported");
    }
  }, [SpeechRecognitionCtor]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setIsListening(false);
  }, []);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  return {
    isListening,
    isSupported,
    transcript,
    interimTranscript,
    error,
    startListening,
    stopListening,
  };
}
