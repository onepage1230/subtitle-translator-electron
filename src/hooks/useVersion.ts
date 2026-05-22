import { useState } from "react";
export const useVersion = () => {
  const [version, setVersion] = useState<string>("1.9.0");
  return version;
};
