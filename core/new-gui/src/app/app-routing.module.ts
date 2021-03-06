import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

import { WorkspaceComponent } from './workspace/component/workspace.component';

import { DashboardComponent } from './dashboard/component/dashboard.component';
import { SavedWorkflowSectionComponent
} from './dashboard/component/feature-container/saved-workflow-section/saved-workflow-section.component';
import { UserDictionarySectionComponent
} from './dashboard/component/feature-container/user-dictionary-section/user-dictionary-section.component';
import { UserFileSectionComponent } from './dashboard/component/feature-container/user-file-section/user-file-section.component';
import { environment } from '../environments/environment';

/*
*  This file defines the url path
*  The workflow workspace is set as default path
*/
const routes: Routes = [
  {
    path: '',
    component: WorkspaceComponent
  }
];


if (environment.userSystemEnabled) {

  /*
   *  The user dashboard is under path '/dashboard'
   *  The saved project is under path '/dashboard/savedworkflow'
   *  The user dictionary is under path '/dashboard/userdictionary'
  */

  routes.push(
    {
      path: 'dashboard',
      component: DashboardComponent,
      children: [
        {
          path: 'savedworkflow',
          component: SavedWorkflowSectionComponent,
        },
        {
          path: 'userdictionary',
          component: UserDictionarySectionComponent
        },
        {
          path: 'userfile',
          component: UserFileSectionComponent
        }
      ]
    });
}

// redirect all other paths to index.
routes.push({
  path: '**',
  redirectTo: ''
});

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule {
}
