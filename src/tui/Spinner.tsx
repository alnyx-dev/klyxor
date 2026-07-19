import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { BRAND_COLOR } from "../constants.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;

interface SpinnerProps {
  text?: string;
}

export function Spinner({ text = "Thinking..." }: SpinnerProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, FRAME_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <Text bold color={BRAND_COLOR}>
      {FRAMES[frame]} {text}
    </Text>
  );
}
