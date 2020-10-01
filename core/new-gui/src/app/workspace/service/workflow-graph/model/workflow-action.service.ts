import { UndoRedoService } from './../../undo-redo/undo-redo.service';
import { OperatorMetadataService } from './../../operator-metadata/operator-metadata.service';
import { WorkflowUtilService } from '../util/workflow-util.service';
import { SyncTexeraModel } from './sync-texera-model';
import { SyncOperatorGroup } from './sync-operator-group';
import { JointGraphWrapper } from './joint-graph-wrapper';
import { JointUIService } from './../../joint-ui/joint-ui.service';
import { WorkflowGraph, WorkflowGraphReadonly } from './workflow-graph';
import { OperatorGroup, Group, OperatorGroupReadonly } from './operator-group';
import { Injectable } from '@angular/core';
import { Point, OperatorPredicate, OperatorLink, OperatorPort, Breakpoint } from '../../../types/workflow-common.interface';

import * as joint from 'jointjs';
import { environment } from './../../../../../environments/environment';
import { cloneDeep } from 'lodash';
import { WorkflowEditorComponent } from './../../../component/workflow-editor/workflow-editor.component';


export interface Command {
  execute(): void;
  undo(): void;
  redo?(): void;
}

type OperatorPosition = {
  position: Point,
  layer: number
};

type GroupInfo = {
  group: Group,
  layer: number
};

/**
 *
 * WorkflowActionService exposes functions (actions) to modify the workflow graph model of both JointJS and Texera,
 *  such as addOperator, deleteOperator, addLink, deleteLink, etc.
 * WorkflowActionService performs checks the validity of these actions,
 *  for example, throws an error if deleting an nonexist operator
 *
 * All changes(actions) to the workflow graph should be called through WorkflowActionService,
 *  then WorkflowActionService will propagate these actions to JointModel and Texera Model automatically.
 *
 * For an overview of the services in WorkflowGraphModule, see workflow-graph-design.md
 *
 */


@Injectable()
export class WorkflowActionService {

  private readonly texeraGraph: WorkflowGraph;
  private readonly jointGraph: joint.dia.Graph;
  private readonly jointGraphWrapper: JointGraphWrapper;
  private readonly operatorGroup: OperatorGroup;
  private readonly syncTexeraModel: SyncTexeraModel;
  private readonly syncOperatorGroup: SyncOperatorGroup;

  constructor(
    private operatorMetadataService: OperatorMetadataService,
    private jointUIService: JointUIService,
    private undoRedoService: UndoRedoService,
    private workflowUtilService: WorkflowUtilService
  ) {
    this.texeraGraph = new WorkflowGraph();
    this.jointGraph = new joint.dia.Graph();
    this.jointGraphWrapper = new JointGraphWrapper(this.jointGraph);
    this.operatorGroup = new OperatorGroup(this.texeraGraph, this.jointGraph, this.jointGraphWrapper,
      this.workflowUtilService, this.jointUIService);
    this.syncTexeraModel = new SyncTexeraModel(this.texeraGraph, this.jointGraphWrapper, this.operatorGroup);
    this.syncOperatorGroup = new SyncOperatorGroup(this.texeraGraph, this.jointGraphWrapper, this.operatorGroup);

    this.handleJointLinkAdd();
    this.handleJointOperatorDrag();
    this.handleHighlightedElementPositionChange();
  }

  public handleJointLinkAdd(): void {
    this.texeraGraph.getLinkAddStream().filter(() => this.undoRedoService.listenJointCommand).subscribe(link => {
      const command: Command = {
        execute: () => { },
        undo: () => this.deleteLinkWithIDInternal(link.linkID),
        redo: () => this.addLinkInternal(link)
      };
      this.executeAndStoreCommand(command);
    });
  }

  // TO-DO: incorporate group drag in undo-redo
  public handleJointOperatorDrag(): void {
    let oldPosition: Point = {x: 0, y: 0};
    let gotOldPosition = false;
    this.jointGraphWrapper.getElementPositionChangeEvent()
      .filter(() => !gotOldPosition)
      .filter(() => this.undoRedoService.listenJointCommand)
      .subscribe(event => {
        oldPosition = event.oldPosition;
        gotOldPosition = true;
      });

    this.jointGraphWrapper.getElementPositionChangeEvent()
      .filter(() => this.undoRedoService.listenJointCommand)
      .debounceTime(100)
      .subscribe(event => {
        gotOldPosition = false;
        const offsetX = event.newPosition.x - oldPosition.x;
        const offsetY = event.newPosition.y - oldPosition.y;
        // remember currently highlighted operators
        const currentHighlighted = this.jointGraphWrapper.getCurrentHighlightedOperatorIDs();
        const command: Command = {
          execute: () => { },
          undo: () => {
            this.jointGraphWrapper.unhighlightOperators(...this.jointGraphWrapper.getCurrentHighlightedOperatorIDs());
            this.jointGraphWrapper.setMultiSelectMode(currentHighlighted.length > 1);
            currentHighlighted.forEach(operatorID => {
              this.jointGraphWrapper.highlightOperators(operatorID);
              this.jointGraphWrapper.setElementPosition(operatorID, -offsetX, -offsetY);
            });
          },
          redo: () => {
            this.jointGraphWrapper.unhighlightOperators(...this.jointGraphWrapper.getCurrentHighlightedOperatorIDs());
            this.jointGraphWrapper.setMultiSelectMode(currentHighlighted.length > 1);
            currentHighlighted.forEach(operatorID => {
              this.jointGraphWrapper.highlightOperators(operatorID);
              this.jointGraphWrapper.setElementPosition(operatorID, offsetX, offsetY);
            });
          }
        };
        this.executeAndStoreCommand(command);
      });
  }

  /**
   * Subscribes to element position change event stream,
   *  checks if the element (operator or group) is moved by user and
   *  if the moved element is currently highlighted,
   *  if it is, moves other highlighted elements (operators and groups) along with it.
   *
   * If a group is highlighted, we consider the whole group as highlighted, including all the
   *  operators embedded in the group and regardless of whether or not they're actually highlighted.
   *  Thus, when a highlighted group moves, all its embedded operators move along with it.
   */
  public handleHighlightedElementPositionChange(): void {
    this.jointGraphWrapper.getElementPositionChangeEvent()
      .filter(() => this.jointGraphWrapper.getListenPositionChange())
      .filter(() => this.undoRedoService.listenJointCommand)
      .filter(movedElement => this.jointGraphWrapper.getCurrentHighlightedOperatorIDs().includes(movedElement.elementID) ||
        this.jointGraphWrapper.getCurrentHighlightedGroupIDs().includes(movedElement.elementID))
      .subscribe(movedElement => {
        const selectedElements = this.jointGraphWrapper.getCurrentHighlightedGroupIDs();
        const movedGroup = this.operatorGroup.getGroupByOperator(movedElement.elementID);
        if (movedGroup && selectedElements.includes(movedGroup.groupID)) {
          movedGroup.operators.forEach((operatorInfo, operatorID) => selectedElements.push(operatorID));
          selectedElements.splice(selectedElements.indexOf(movedGroup.groupID), 1);
        }
        this.jointGraphWrapper.getCurrentHighlightedOperatorIDs().forEach(operatorID => {
          const group = this.operatorGroup.getGroupByOperator(operatorID);
          if (!group || !this.jointGraphWrapper.getCurrentHighlightedGroupIDs().includes(group.groupID)) {
            selectedElements.push(operatorID);
          }
        });
        const offsetX = movedElement.newPosition.x - movedElement.oldPosition.x;
        const offsetY = movedElement.newPosition.y - movedElement.oldPosition.y;
        this.jointGraphWrapper.setListenPositionChange(false);
        this.undoRedoService.setListenJointCommand(false);
        selectedElements.filter(elementID => elementID !== movedElement.elementID).forEach(elementID =>
          this.jointGraphWrapper.setElementPosition(elementID, offsetX, offsetY));
        this.jointGraphWrapper.setListenPositionChange(true);
        this.undoRedoService.setListenJointCommand(true);
      });
  }

  /**
   * Gets the read-only version of the TexeraGraph
   *  to access the properties and event streams.
   *
   * Texera Graph contains information about the logical workflow plan of Texera,
   *  such as the types and properties of the operators.
   */
  public getTexeraGraph(): WorkflowGraphReadonly {
    return this.texeraGraph;
  }

  /**
   * Gets the JointGraph Wrapper, which contains
   *  getter for properties and event streams as RxJS Observables.
   *
   * JointJS Graph contains information about the UI,
   *  such as the position of operator elements, and the event of user dragging a cell around.
   */
  public getJointGraphWrapper(): JointGraphWrapper {
    return this.jointGraphWrapper;
  }

  /**
   * Gets the read-only version of the OperatorGroup
   *  which provides access to properties, event streams,
   *  and some helper functions.
   */
  public getOperatorGroup(): OperatorGroupReadonly {
    return this.operatorGroup;
  }

  /**
   * Let the JointGraph model be attached to the joint paper (paperOptions will be passed to Joint Paper constructor).
   *
   * We don't want to expose JointModel as a public variable, so instead we let JointPaper to pass the constructor options,
   *  and JointModel can be still attached to it without being publicly accessible by other modules.
   *
   * @param paperOptions JointJS paper options
   */
  public attachJointPaper(paperOptions: joint.dia.Paper.Options): joint.dia.Paper.Options {
    paperOptions.model = this.jointGraph;
    return paperOptions;
  }

  /**
   * Adds an opreator to the workflow graph at a point.
   * Throws an Error if the operator ID already existed in the Workflow Graph.
   *
   * @param operator
   * @param point
   */
  public addOperator(operator: OperatorPredicate, point: Point): void {
    // remember currently highlighted operators and groups
    const currentHighlightedOperators = this.jointGraphWrapper.getCurrentHighlightedOperatorIDs();
    const currentHighlightedGroups = this.jointGraphWrapper.getCurrentHighlightedGroupIDs();

    const command: Command = {
      execute: () => {
        // turn off multiselect since there's only one operator added
        this.jointGraphWrapper.setMultiSelectMode(false);
        // add operator
        this.addOperatorInternal(operator, point);
        // highlight the newly added operator
        this.jointGraphWrapper.highlightOperators(operator.operatorID);
      },
      undo: () => {
        // remove the operator from JointJS
        this.deleteOperatorInternal(operator.operatorID);
        // restore previous highlights
        this.jointGraphWrapper.unhighlightOperators(...this.jointGraphWrapper.getCurrentHighlightedOperatorIDs());
        this.jointGraphWrapper.unhighlightGroups(...this.jointGraphWrapper.getCurrentHighlightedGroupIDs());
        this.jointGraphWrapper.setMultiSelectMode(currentHighlightedOperators.length + currentHighlightedGroups.length > 1);
        this.jointGraphWrapper.highlightOperators(...currentHighlightedOperators);
        this.jointGraphWrapper.highlightGroups(...currentHighlightedGroups);
      }
    };
    this.executeAndStoreCommand(command);
  }

  /**
    * Deletes an operator from the workflow graph
    * Throws an Error if the operator ID doesn't exist in the Workflow Graph.
    * @param operatorID
    */
  public deleteOperator(operatorID: string): void {
    const operator = this.getTexeraGraph().getOperator(operatorID);
    const position = this.getOperatorGroup().getOperatorPositionByGroup(operatorID);
    const layer = this.getOperatorGroup().getOperatorLayerByGroup(operatorID);

    const linksToDelete = new Map<OperatorLink, number>();
    this.getTexeraGraph().getAllLinks()
      .filter(link => link.source.operatorID === operatorID || link.target.operatorID === operatorID)
      .forEach(link => linksToDelete.set(link, this.getOperatorGroup().getLinkLayerByGroup(link.linkID)));

    const group = cloneDeep(this.getOperatorGroup().getGroupByOperator(operatorID));
    const groupLayer = group ? this.getJointGraphWrapper().getCellLayer(group.groupID) : undefined;

    const command: Command = {
      execute: () => {
        linksToDelete.forEach((linkLayer, link) => this.deleteLinkWithIDInternal(link.linkID));
        this.deleteOperatorInternal(operatorID);
        if (group && this.getOperatorGroup().getGroup(group.groupID).operators.size < 2) {
          this.deleteGroupInternal(group.groupID);
        }
      },
      undo: () => {
        this.addOperatorInternal(operator, position);
        this.getJointGraphWrapper().setCellLayer(operatorID, layer);
        linksToDelete.forEach((linkLayer, link) => {
          this.addLinkInternal(link);
          this.getJointGraphWrapper().setCellLayer(link.linkID, linkLayer);
        });
        if (group && this.getOperatorGroup().hasGroup(group.groupID)) {
          this.getOperatorGroup().addOperatorToGroup(operatorID, group.groupID);
        } else if (group && groupLayer) {
          this.addGroupInternal(cloneDeep(group));
          this.getJointGraphWrapper().setCellLayer(group.groupID, groupLayer);
        }
        if (!group || !group.collapsed) {
          // turn off multiselect since only the deleted operator will be added
          this.getJointGraphWrapper().setMultiSelectMode(false);
          this.getJointGraphWrapper().highlightOperators(operatorID);
        }
      }
    };
    this.executeAndStoreCommand(command);
  }

  /**
   * Adds given operators and links to the workflow graph.
   * @param operatorsAndPositions
   * @param links
   */
  public addOperatorsAndLinks(operatorsAndPositions: {op: OperatorPredicate, pos: Point}[], links: OperatorLink[],
    breakpoints?: ReadonlyMap<string, Breakpoint>
  ): void {
    // remember currently highlighted operators and groups
    const currentHighlightedOperators = this.jointGraphWrapper.getCurrentHighlightedOperatorIDs();
    const currentHighlightedGroups = this.jointGraphWrapper.getCurrentHighlightedGroupIDs();
    const command: Command = {
      execute: () => {
        // unhighlight previous highlights
        this.jointGraphWrapper.unhighlightOperators(...this.jointGraphWrapper.getCurrentHighlightedOperatorIDs());
        this.jointGraphWrapper.unhighlightGroups(...this.jointGraphWrapper.getCurrentHighlightedGroupIDs());
        this.jointGraphWrapper.setMultiSelectMode(operatorsAndPositions.length > 1);
        operatorsAndPositions.forEach(o => {
          this.addOperatorInternal(o.op, o.pos);
          this.jointGraphWrapper.highlightOperators(o.op.operatorID);
        });
        links.forEach(l => this.addLinkInternal(l));
        if (breakpoints !== undefined) {
          breakpoints.forEach((breakpoint, linkID) => this.setLinkBreakpointInternal(linkID, breakpoint));
        }
      },
      undo: () => {
        // remove links
        links.forEach(l => this.deleteLinkWithIDInternal(l.linkID));
        // remove the operators from JointJS
        operatorsAndPositions.forEach(o => this.deleteOperatorInternal(o.op.operatorID));
        if (breakpoints !== undefined) {
          breakpoints.forEach((breakpoint, linkID) => this.setLinkBreakpointInternal(linkID, undefined));
        }
        // restore previous highlights
        this.jointGraphWrapper.unhighlightOperators(...this.jointGraphWrapper.getCurrentHighlightedOperatorIDs());
        this.jointGraphWrapper.unhighlightGroups(...this.jointGraphWrapper.getCurrentHighlightedGroupIDs());
        this.jointGraphWrapper.setMultiSelectMode(currentHighlightedOperators.length + currentHighlightedGroups.length > 1);
        this.jointGraphWrapper.highlightOperators(...currentHighlightedOperators);
        this.jointGraphWrapper.highlightGroups(...currentHighlightedGroups);
      }
    };
    this.executeAndStoreCommand(command);
  }

  /**
   * Deletes given operators and links from the workflow graph.
   * @param operatorIDs
   * @param linkIDs
   */
  public deleteOperatorsAndLinks(operatorIDs: string[], linkIDs: string[]): void {
    // save operators to be deleted and their current positions
    const operatorsAndPositions = new Map<OperatorPredicate, OperatorPosition>();
    operatorIDs.forEach(operatorID => operatorsAndPositions.set(this.getTexeraGraph().getOperator(operatorID),
      {position: this.getOperatorGroup().getOperatorPositionByGroup(operatorID),
       layer: this.getOperatorGroup().getOperatorLayerByGroup(operatorID)}));

    // save links to be deleted, including links needs to be deleted and links affected by deleted operators
    const linksToDelete = new Map<OperatorLink, number>();
    // delete links required by this command
    linkIDs.map(linkID => this.getTexeraGraph().getLinkWithID(linkID))
      .forEach(link => linksToDelete.set(link, this.getOperatorGroup().getLinkLayerByGroup(link.linkID)));
    // delete links related to the deleted operator
    this.getTexeraGraph().getAllLinks()
      .filter(link => operatorIDs.includes(link.source.operatorID) || operatorIDs.includes(link.target.operatorID))
      .forEach(link => linksToDelete.set(link, this.getOperatorGroup().getLinkLayerByGroup(link.linkID)));

    // save groups that deleted operators reside in
    const groups = new Map<string, GroupInfo>();
    operatorIDs.forEach(operatorID => {
      const group = cloneDeep(this.getOperatorGroup().getGroupByOperator(operatorID));
      if (group) {
        groups.set(operatorID, {group, layer: this.getJointGraphWrapper().getCellLayer(group.groupID)});
      }
    });

    // remember currently highlighted operators and groups
    const currentHighlightedOperators = this.jointGraphWrapper.getCurrentHighlightedOperatorIDs();
    const currentHighlightedGroups = this.jointGraphWrapper.getCurrentHighlightedGroupIDs();

    const command: Command = {
      execute: () => {
        linksToDelete.forEach((layer, link) => this.deleteLinkWithIDInternal(link.linkID));
        operatorIDs.forEach(operatorID => {
          this.deleteOperatorInternal(operatorID);
          // if the group has less than 2 operators left, delete the group
          const groupInfo = groups.get(operatorID);
          if (groupInfo && this.getOperatorGroup().hasGroup(groupInfo.group.groupID) &&
            this.getOperatorGroup().getGroup(groupInfo.group.groupID).operators.size < 2) {
            this.deleteGroupInternal(groupInfo.group.groupID);
          }
        });
      },
      undo: () => {
        operatorsAndPositions.forEach((pos, operator) => {
          this.addOperatorInternal(operator, pos.position);
          this.getJointGraphWrapper().setCellLayer(operator.operatorID, pos.layer);
          // if the group still exists, add the operator back to the group
          const groupInfo = groups.get(operator.operatorID);
          if (groupInfo && this.getOperatorGroup().hasGroup(groupInfo.group.groupID)) {
            this.getOperatorGroup().addOperatorToGroup(operator.operatorID, groupInfo.group.groupID);
          }
        });
        linksToDelete.forEach((layer, link) => {
          this.addLinkInternal(link);
          // if the link is added to a collapsed group, change its saved layer in the group
          const group = this.getOperatorGroup().getGroupByLink(link.linkID);
          if (group && group.collapsed) {
            const linkInfo = group.links.get(link.linkID);
            if (linkInfo) { linkInfo.layer = layer; }
          } else {
            this.getJointGraphWrapper().setCellLayer(link.linkID, layer);
          }
        });
        // add back groups that were deleted when deleting operators
        groups.forEach(groupInfo => {
          if (!this.getOperatorGroup().hasGroup(groupInfo.group.groupID)) {
            this.addGroupInternal(cloneDeep(groupInfo.group));
            this.getJointGraphWrapper().setCellLayer(groupInfo.group.groupID, groupInfo.layer);
          }
        });
        // restore previous highlights
        this.jointGraphWrapper.unhighlightOperators(...this.jointGraphWrapper.getCurrentHighlightedOperatorIDs());
        this.jointGraphWrapper.unhighlightGroups(...this.jointGraphWrapper.getCurrentHighlightedGroupIDs());
        this.jointGraphWrapper.setMultiSelectMode(currentHighlightedOperators.length + currentHighlightedGroups.length > 1);
        this.jointGraphWrapper.highlightOperators(...currentHighlightedOperators);
        this.jointGraphWrapper.highlightGroups(...currentHighlightedGroups);
      }
    };

    this.executeAndStoreCommand(command);
  }

  // not used I believe
  /**
   * Adds a link to the workflow graph
   * Throws an Error if the link ID or the link with same source and target already exists.
   * @param link
   */
  public addLink(link: OperatorLink): void {
    const command: Command = {
      execute: () => this.addLinkInternal(link),
      undo: () => this.deleteLinkWithIDInternal(link.linkID)
    };
    this.executeAndStoreCommand(command);
  }

  /**
   * Deletes a link with the linkID from the workflow graph
   * Throws an Error if the linkID doesn't exist in the workflow graph.
   * @param linkID
   */
  public deleteLinkWithID(linkID: string): void {
    const link = this.getTexeraGraph().getLinkWithID(linkID);
    const layer = this.getJointGraphWrapper().getCellLayer(linkID);
    const command: Command = {
      execute: () => this.deleteLinkWithIDInternal(linkID),
      undo: () => {
        this.addLinkInternal(link);
        const group = this.getOperatorGroup().getGroupByLink(linkID);
        if (group && group.collapsed) {
          const linkInfo = group.links.get(linkID);
          if (linkInfo) { linkInfo.layer = layer; }
        } else {
          this.getJointGraphWrapper().setCellLayer(linkID, layer);
        }
      }
    };
    this.executeAndStoreCommand(command);
  }

  public deleteLink(source: OperatorPort, target: OperatorPort): void {
    const link = this.getTexeraGraph().getLink(source, target);
    this.deleteLinkWithID(link.linkID);
  }

  /**
   * Adds a group to the workflow graph. All cells related to the group
   * (including the group itself) will be moved to the front.
   *
   * @param group
   */
  public addGroup(group: Group): void {
    const command: Command = {
      execute: () => {
        this.addGroupInternal(group);
        this.operatorGroup.moveGroupToLayer(group, this.operatorGroup.getHighestLayer() + 1);
      },
      undo: () => {}
    };
    this.executeAndStoreCommand(command);
  }

  /**
   * Adds given groups to the workflow graph.
   * @param groups
   */
  public addGroups(groups: Group[]): void {
    const command: Command = {
      execute: () => {
        groups.forEach(group => {
          this.addGroupInternal(group);
          this.operatorGroup.moveGroupToLayer(group, this.operatorGroup.getHighestLayer() + 1);
        });
      },
      undo: () => {}
    };
    this.executeAndStoreCommand(command);
  }

  /**
   * Deletes a group from the workflow graph.
   * Throws an error if the group ID doesn't exist in group ID map.
   *
   * @param group
   */
  public deleteGroup(groupID: string): void {
    const command: Command = {
      execute: () => this.deleteGroupInternal(groupID),
      undo: () => {}
    };
    this.executeAndStoreCommand(command);
  }

  /**
   * Deletes given groups from the workflow graph.
   * @param groupIDs
   */
  public deleteGroups(groupIDs: string[]): void {
    const command: Command = {
      execute: () => groupIDs.forEach(groupID => this.deleteGroupInternal(groupID)),
      undo: () => {}
    };
    this.executeAndStoreCommand(command);
  }

  /**
   * Collapses the given group on the graph.
   * Throws an error if the group is already collapsed, otherwise hides all
   * operators and links within the group.
   *
   * @param groupID
   */
  public collapseGroup(groupID: string): void {
    // TO-DO: highlight group on collapsing & expanding
    const command: Command = {
      execute: () => this.collapseGroupInternal(groupID),
      undo: () => {}
    };
    this.executeAndStoreCommand(command);
  }

  /**
   * Collapses given groups on the graph.
   * @param groupIDs
   */
  public collapseGroups(groupIDs: string[]): void {
    const command: Command = {
      execute: () => groupIDs.forEach(groupID => this.collapseGroupInternal(groupID)),
      undo: () => {}
    };
    this.executeAndStoreCommand(command);
  }

  /**
   * Expands the given group on the graph.
   * Throws an error if the group is already expanded, otherwise shows all
   * hidden operators and links in the group.
   *
   * @param groupID
   */
  public expandGroup(groupID: string): void {
    const command: Command = {
      execute: () => this.expandGroupInternal(groupID),
      undo: () => {}
    };
    this.executeAndStoreCommand(command);
  }

  /**
   * Expands given groups on the graph.
   * @param groupIDs
   */
  public expandGroups(groupIDs: string[]): void {
    const command: Command = {
      execute: () => groupIDs.forEach(groupID => this.expandGroupInternal(groupID)),
      undo: () => {}
    };
    this.executeAndStoreCommand(command);
  }

  /**
   * Deletes the given group and all operators embedded in it.
   * @param groupID
   */
  public deleteGroupAndOperators(groupID: string): void {
    const command: Command = {
      execute: () => this.deleteGroupAndOperatorsInternal(groupID),
      undo: () => {}
    };
    this.executeAndStoreCommand(command);
  }

  /**
   * Deletes given groups and all operators embedded in them.
   * @param groupID
   */
  public deleteGroupsAndOperators(groupIDs: string[]): void {
    const command: Command = {
      execute: () => groupIDs.forEach(groupID => this.deleteGroupAndOperatorsInternal(groupID)),
      undo: () => {}
    };
    this.executeAndStoreCommand(command);
  }

  // problem here
  public setOperatorProperty(operatorID: string, newProperty: object): void {
    console.log('set operator property');
    console.log(operatorID);
    console.log(newProperty);
    const prevProperty = this.getTexeraGraph().getOperator(operatorID).operatorProperties;
    const group = this.getOperatorGroup().getGroupByOperator(operatorID);
    const command: Command = {
      execute: () => {
        const currentHighlightedOperators = this.jointGraphWrapper.getCurrentHighlightedOperatorIDs();
        if ((!group || !group.collapsed) && !currentHighlightedOperators.includes(operatorID)) {
          this.jointGraphWrapper.setMultiSelectMode(false);
          this.jointGraphWrapper.highlightOperators(operatorID);
        } else if (!group || !group.collapsed) {
          currentHighlightedOperators.splice(currentHighlightedOperators.indexOf(operatorID), 1);
          this.jointGraphWrapper.unhighlightOperators(...currentHighlightedOperators);
          this.jointGraphWrapper.unhighlightGroups(...this.jointGraphWrapper.getCurrentHighlightedGroupIDs());
        }
        this.setOperatorPropertyInternal(operatorID, newProperty);
      },
      undo: () => {
        const currentHighlightedOperators = this.jointGraphWrapper.getCurrentHighlightedOperatorIDs();
        if ((!group || !group.collapsed) && !currentHighlightedOperators.includes(operatorID)) {
          this.jointGraphWrapper.setMultiSelectMode(false);
          this.jointGraphWrapper.highlightOperators(operatorID);
        } else if (!group || !group.collapsed) {
          currentHighlightedOperators.splice(currentHighlightedOperators.indexOf(operatorID), 1);
          this.jointGraphWrapper.unhighlightOperators(...currentHighlightedOperators);
          this.jointGraphWrapper.unhighlightGroups(...this.jointGraphWrapper.getCurrentHighlightedGroupIDs());
        }
        this.setOperatorPropertyInternal(operatorID, prevProperty);
      }
    };
    this.executeAndStoreCommand(command);
  }

  /**
   * set a given link's breakpoint properties to specific values
   */
  public setLinkBreakpoint(linkID: string, newBreakpoint: Breakpoint | undefined): void {
    const prevBreakpoint = this.getTexeraGraph().getLinkBreakpoint(linkID);
    const command: Command = {
      execute: () => {
        this.setLinkBreakpointInternal(linkID, newBreakpoint);
      },
      undo: () => {
        this.setLinkBreakpointInternal(linkID, prevBreakpoint);
      }
    };
    this.executeAndStoreCommand(command);
  }

  /**
   * Set the link's breakpoint property to empty to remove the breakpoint
   *
   * @param linkID
   */
  public removeLinkBreakpoint(linkID: string): void {
    this.setLinkBreakpoint(linkID, undefined);
  }

  private addOperatorInternal(operator: OperatorPredicate, point: Point): void {
    // check that the operator doesn't exist
    this.texeraGraph.assertOperatorNotExists(operator.operatorID);
    // check that the operator type exists
    if (! this.operatorMetadataService.operatorTypeExists(operator.operatorType)) {
      throw new Error(`operator type ${operator.operatorType} is invalid`);
    }
    // get the JointJS UI element for operator
    const operatorJointElement = this.jointUIService.getJointOperatorElement(operator, point);

    // add operator to joint graph first
    // if jointJS throws an error, it won't cause the inconsistency in texera graph
    this.jointGraph.addCell(operatorJointElement);
    this.jointGraphWrapper.setCellLayer(operator.operatorID, this.operatorGroup.getHighestLayer() + 1);

    // add operator to texera graph
    this.texeraGraph.addOperator(operator);
  }

  private deleteOperatorInternal(operatorID: string): void {
    this.texeraGraph.assertOperatorExists(operatorID);
    const group = this.operatorGroup.getGroupByOperator(operatorID);
    if (group && group.collapsed) {
      this.texeraGraph.deleteOperator(operatorID);
    } else {
      // remove the operator from JointJS
      this.jointGraph.getCell(operatorID).remove();
      // JointJS operator delete event will propagate and trigger Texera operator delete
    }
  }

  private addLinkInternal(link: OperatorLink): void {
    this.texeraGraph.assertLinkNotExists(link);
    this.texeraGraph.assertLinkIsValid(link);

    const sourceGroup = this.operatorGroup.getGroupByOperator(link.source.operatorID);
    const targetGroup = this.operatorGroup.getGroupByOperator(link.target.operatorID);

    if (sourceGroup && targetGroup && sourceGroup.groupID === targetGroup.groupID && sourceGroup.collapsed) {
      this.texeraGraph.addLink(link);
    } else {
      const jointLinkCell = JointUIService.getJointLinkCell(link);
      if (sourceGroup && sourceGroup.collapsed) {
        jointLinkCell.set('source', {id: sourceGroup.groupID});
      }
      if (targetGroup && targetGroup.collapsed) {
        jointLinkCell.set('target', {id: targetGroup.groupID});
      }
      this.operatorGroup.setSyncTexeraGraph(false);
      this.jointGraph.addCell(jointLinkCell);
      this.jointGraphWrapper.setCellLayer(link.linkID, this.operatorGroup.getHighestLayer() + 1);
      this.operatorGroup.setSyncTexeraGraph(true);
      this.texeraGraph.addLink(link);
    }
  }

  private deleteLinkWithIDInternal(linkID: string): void {
    this.texeraGraph.assertLinkWithIDExists(linkID);
    const group = this.operatorGroup.getGroupByLink(linkID);
    if (group && group.collapsed) {
      this.texeraGraph.deleteLinkWithID(linkID);
    } else {
      this.jointGraph.getCell(linkID).remove();
      // JointJS link delete event will propagate and trigger Texera link delete
    }
  }

  private addGroupInternal(group: Group): void {
    this.operatorGroup.assertGroupNotExists(group.groupID);
    this.operatorGroup.assertGroupIsValid(group);

    // get the JointJS UI element for the group and add it to joint graph
    const groupJointElement = this.jointUIService.getJointGroupElement(group, this.operatorGroup.getGroupBoundingBox(group));
    this.jointGraph.addCell(groupJointElement);

    // add the group to group ID map
    this.operatorGroup.addGroup(group);

    // collapse the group if it's specified as collapsed
    if (group.collapsed) {
      this.operatorGroup.setGroupCollapsed(group.groupID, false);
      this.collapseGroupInternal(group.groupID);
    }
  }

  private deleteGroupInternal(groupID: string): void {
    const group = this.operatorGroup.getGroup(groupID);

    // if the group is collapsed, expand it before ungrouping
    if (group.collapsed) {
      this.expandGroupInternal(groupID);
    }

    // delete the group from joint graph
    const groupJointElement = this.jointGraph.getCell(groupID);
    groupJointElement.remove();

    // delete the group from group ID map
    this.operatorGroup.deleteGroup(groupID);
  }

  private collapseGroupInternal(groupID: string): void {
    const group = this.operatorGroup.getGroup(groupID);
    this.operatorGroup.assertGroupNotCollapsed(group);

    // collapse the group on joint graph
    this.jointGraphWrapper.setElementSize(groupID, 170, 30);
    this.operatorGroup.hideOperatorsAndLinks(group);

    // update the group in OperatorGroup
    this.operatorGroup.collapseGroup(groupID);
  }

  private expandGroupInternal(groupID: string): void {
    const group = this.operatorGroup.getGroup(groupID);
    this.operatorGroup.assertGroupIsCollapsed(group);

    // expand the group on joint graph
    this.operatorGroup.repositionGroup(group);
    this.operatorGroup.showOperatorsAndLinks(group);

    // update the group in OperatorGroup
    this.operatorGroup.expandGroup(groupID);
  }

  private deleteGroupAndOperatorsInternal(groupID: string): void {
    const group = this.operatorGroup.getGroup(groupID);
    // delete operators and links from the group
    group.links.forEach((linkInfo, linkID) => this.deleteLinkWithIDInternal(linkID));
    group.inLinks.forEach(linkID => this.deleteLinkWithIDInternal(linkID));
    group.outLinks.forEach(linkID => this.deleteLinkWithIDInternal(linkID));
    group.operators.forEach((operatorInfo, operatorID) => this.deleteOperatorInternal(operatorID));
    // delete the group from joint graph and group ID map
    this.jointGraph.getCell(groupID).remove();
    this.operatorGroup.deleteGroup(groupID);
  }

  // use this to modify properties
  private setOperatorPropertyInternal(operatorID: string, newProperty: object) {
    this.texeraGraph.setOperatorProperty(operatorID, newProperty);
  }

  private executeAndStoreCommand(command: Command): void {
    this.undoRedoService.setListenJointCommand(false);
    command.execute();
    this.undoRedoService.addCommand(command);
    this.undoRedoService.setListenJointCommand(true);
  }

  private setLinkBreakpointInternal(linkID: string, newBreakpoint: Breakpoint | undefined): void {
    this.texeraGraph.setLinkBreakpoint(linkID, newBreakpoint);
    if (newBreakpoint === undefined || Object.keys(newBreakpoint).length === 0) {
      this.getJointGraphWrapper().hideLinkBreakpoint(linkID);
    } else {
      this.getJointGraphWrapper().showLinkBreakpoint(linkID);
    }
  }

}
