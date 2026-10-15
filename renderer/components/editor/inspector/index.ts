/**
 * The editor's right dock (CP3 Inspector): every clip tool and property editor.
 *   <Inspector />   reads the selection from the editor store.
 * Reusable pieces for other editor modules: KeyframeGraph / KeyframeEditor / BezierEditor (keyframe + easing UI),
 * NumberField (scrubbable numeric input).
 */
export { Inspector } from './inspector';
export { KeyframeGraph, type KeyframeGraphProps } from './graph/keyframe-graph';
export { KeyframeEditor, type KeyframeEditorProps } from './graph/keyframe-editor';
export { SelectedKeyframeEditor } from './graph/path-keyframe-editor';
export { BezierEditor } from './graph/bezier-editor';
export { NumberField, type NumberFieldProps } from './fields/number-field';
