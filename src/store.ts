import { configureStore } from "@reduxjs/toolkit";
import fileReducer from "./store/file";
export default configureStore({
  reducer: {
    file: fileReducer,
  },
});
